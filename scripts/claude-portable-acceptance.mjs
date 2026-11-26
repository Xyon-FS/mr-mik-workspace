// Opt-in real-provider acceptance against the packaged service and UI. No fake
// transport; no login automation. --check sends zero model prompts.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from '../desktop/service/test/fixtures.mjs';
import { isolatedClaudeEnvironment, isolatedClaudeStatus } from './claude-portable-profile.mjs';

const args = process.argv.slice(2), option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const profile = option('--profile');
if (!profile || !args.includes('--check') && !args.includes('--run')) throw new Error('Usage: node scripts/claude-portable-acceptance.mjs --profile <test-profile> --check | --run');
const config = JSON.parse(await readFile(path.join(path.resolve(profile), 'test-profile.json'), 'utf8'));
if (config.version !== 1 || config.profileRoot !== path.resolve(profile) || config.maxPrompts !== 10) throw new Error('An explicit prepared test profile with the agreed ten-prompt limit is required.');
if (option('--portable')) config.portable = path.resolve(option('--portable'));
const retryOnly = args.includes('--message-actions-retry-only');
const actionsOnly = args.includes('--message-actions-only') || retryOnly;
const attachmentBatch = args.includes('--attachments-only') || actionsOnly;
const maximumAllowed = attachmentBatch ? 5 : config.maxPrompts;
const batch = attachmentBatch ? 'attachments-20261028' : null;
const auth = isolatedClaudeStatus(config.profileRoot);
const budgetFile = path.join(config.profileRoot, batch ? `acceptance-budget-${batch}.json` : 'acceptance-budget.json');
function spentPrompts() {
  try { const saved = JSON.parse(readFileSync(budgetFile, 'utf8')); if (!Number.isInteger(saved.promptsReserved) || saved.promptsReserved < 0 || saved.promptsReserved > maximumAllowed) throw new Error('Invalid budget'); return saved.promptsReserved; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw new Error('The live-test budget is unreadable. No inference is allowed.'); }
}
if (!args.includes('--run')) {
  console.log(JSON.stringify({ readyForLogin: !auth.loggedIn, loggedIn: auth.loggedIn, authMethod: auth.authMethod, directoryMatches: !!auth.configDirectory && path.resolve(auth.configDirectory).toLowerCase() === path.join(config.profileRoot, 'Claude').toLowerCase(), promptsAlreadyReserved: spentPrompts(), maxUserPromptsPerRun: 5, maximumAllowedAcrossRuns: maximumAllowed, modelPolicy: 'Native Haiku catalog entry only; stop if unavailable', paidApiFallback: false }, null, 2));
} else {
  if (!auth.loggedIn || auth.authMethod !== 'claude.ai' || !auth.configDirectory || path.resolve(auth.configDirectory).toLowerCase() !== path.join(config.profileRoot, 'Claude').toLowerCase()) throw new Error('Sign in yourself through the isolated native Claude login. Live tests require subscription authentication in that exact config directory; no prompt sent.');
  const lockPath = path.join(config.profileRoot, 'acceptance-budget.lock');
  const alreadySpent = spentPrompts();
  const lock = openSync(lockPath, 'wx');
  const originalEnv = { ...process.env }, env = isolatedClaudeEnvironment(config.profileRoot);
  for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
  Object.assign(process.env, env);
  let service, browser, prompts = 0, model, failure, failureDetail, stage = 'startup';
  const checks = [], root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const focusedResume = args.includes('--resume-stop-only');
  const safePrompts = new Set(['What color is the image? Reply one word.', 'Read the attached text file. Reply its word only.', 'Reply exactly MIK_OK.', 'Read fixture.txt with Read. Reply its word. No other tools.', 'Use AskUserQuestion: choose A or B. Then reply OK.', 'Reply STOP_CHECK.', 'Reply exactly RESUME_OK.', 'Read fixture.txt. Reply PLAN_OK; stay in Plan.']);
  const record = async () => writeFile(path.join(config.profileRoot, retryOnly ? 'acceptance-result-message-actions-retry-20261028.json' : actionsOnly ? 'acceptance-result-message-actions-20261028.json' : batch ? `acceptance-result-${batch}.json` : 'acceptance-result.json'), JSON.stringify({ completedAt: new Date().toISOString(), promptsSent: prompts, totalPromptsReserved: alreadySpent + prompts, maximumAllowed: maximumAllowed, model, authMethod: auth.authMethod, checks, failure, failureDetail, stage }, null, 2) + '\n');
  try {
    const base = await mkdtemp(path.join(os.tmpdir(), 'mik-packaged-claude-live-'));
    const repo = path.join(base, 'hub');
    await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(path.join(repo, '.git'));
    await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
    await writeFile(path.join(repo, 'fixture.txt'), 'MIK_READ_OK\n');
    const bundledService = await import(pathToFileURL(path.join(config.portable, 'App/runtime/service/server.mjs')).href);
    const { ClaudeChat } = await import(pathToFileURL(path.join(config.portable, 'App/runtime/service/claude-chat.mjs')).href);
    service = await createService({ repo, uiDir: path.join(config.portable, 'App/runtime/ui'), mcpOptions: { home: config.profileRoot, env }, profileOptions: { root: path.join(base, 'accounts') } }, bundledService.createService);
    service.sessions.createGraphicalRuntime = options => {
      const runtime = new ClaudeChat(options), submit = runtime.submit.bind(runtime);
      runtime.submit = (text = runtime.draft) => {
        if (!safePrompts.has(text) || prompts >= 5 || alreadySpent + prompts >= maximumAllowed) throw new Error('Live acceptance prompt budget or content boundary reached.');
        if (!/haiku/i.test(runtime.session.graphicalModel || '') || runtime.session.effort !== 'low') throw new Error('The least-cost native model and low effort must be selected before inference.');
        prompts++;
        // Reserve before delivery, including failures of uncertain delivery. A
        // crash or a rerun cannot silently reset the user's total ten-prompt cap.
        writeFileSync(budgetFile, JSON.stringify({ promptsReserved: alreadySpent + prompts, maximumAllowed: maximumAllowed }) + '\n', { mode: 0o600 });
        return submit(text);
      };
      return runtime;
    };
    let seeded = {};
    if (retryOnly) {
      const nativeId = randomUUID(), userId = randomUUID(), answerId = randomUUID(), turnId = randomUUID(), modelId = 'synthetic-stored-response';
      const { claudeAttachmentInput, inspectClaudeAttachment } = await import(pathToFileURL(path.join(config.portable, 'App/runtime/service/claude-chat-attachments.mjs')));
      const attachment = (await inspectClaudeAttachment(path.join(repo, 'fixture.txt'))).metadata;
      const input = await claudeAttachmentInput('Reply exactly MIK_OK.', [attachment]);
      const folder = path.join(env.CLAUDE_CONFIG_DIR, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-')); await mkdir(folder, { recursive: true });
      const records = [{ type: 'user', uuid: userId, parentUuid: null, message: { role: 'user', content: input.blocks } }, { type: 'assistant', uuid: answerId, parentUuid: userId, message: { id: modelId, role: 'assistant', model: 'synthetic-history-fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Synthetic stored response; no prior inference.' }] } }];
      await writeFile(path.join(folder, `${nativeId}.jsonl`), records.map((entry, index) => JSON.stringify({ ...entry, sessionId: nativeId, cwd: repo, isSidechain: false, version: '2.1.311', timestamp: new Date(index + 1).toISOString() })).join('\n') + '\n');
      seeded = { resumeId: nativeId, providerSeed: { state: { status: 'closed', sessionId: nativeId, items: [{ id: userId, turnId, type: 'userMessage', text: 'Reply exactly MIK_OK.', attachments: [attachment] }, { id: `${modelId}:0`, nativeUuid: answerId, turnId, type: 'agentMessage', text: 'Synthetic stored response; no prior inference.', final: true }], turns: [{ id: turnId, status: 'completed', startedAt: 1, completedAt: 2 }], requests: [], error: '', uncertain: false }, draft: '', attachments: [], previewPaths: [attachment.resolvedPath] } };
    }
    const session = await service.sessions.create({ agent: 'claude', chatInterface: 'chat', cwd: repo, name: retryOnly ? 'Synthetic stored-history retry fixture' : 'Isolated live acceptance', effort: 'low', bypass: false, ...seeded });
    let runtime = service.sessions.get(session.id).graphical;
    const cheapest = runtime.models().find(entry => /haiku/i.test(entry.value + ' ' + entry.label));
    if (!cheapest) throw new Error('No native Haiku catalog entry; stopped before inference rather than selecting a costlier model.');
    model = cheapest.value; await runtime.configure(model);
    browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
    await page.goto(service.urls.chats);
    const chat = page.getByRole('region', { name: 'Claude graphical chat', exact: true }), input = chat.getByRole('textbox', { name: 'Message Claude', exact: true });
    await expect(chat).toBeVisible();
    const send = async text => {
      const before = prompts;
      await input.fill(text); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => prompts).toBe(before + 1);
      await expect(input).toHaveValue('');
    };
    const settle = async () => {
      await expect.poll(() => runtime.snapshot().working, { timeout: 60000 }).toBe(false);
      const snapshot = runtime.snapshot();
      if (snapshot.error || snapshot.uncertain) throw new Error('Native turn failed or delivery is uncertain; no automatic retry.');
    };
    if (retryOnly) {
      stage = 'single native retry from synthetic stored-history fixture';
      const originalRuntime = runtime, originalCount = runtime.snapshot().items.length;
      await chat.getByRole('button', { name: 'Retry response in a new chat', exact: true }).last().click();
      await expect(page.locator('.chat-tab.selected')).toContainText('Retry', { timeout: 20000 });
      const child = service.sessions.active().find(item => item.messageOrigin?.kind === 'retry');
      assert.ok(child); runtime = service.sessions.get(child.id).graphical;
      await expect.poll(() => prompts, { timeout: 15000 }).toBe(1); await settle();
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true }).last()).toContainText('MIK_OK');
      assert.equal(originalRuntime.snapshot().items.length, originalCount);
      assert.notEqual(runtime.session.nativeId, originalRuntime.session.nativeId);
      assert.equal(runtime.snapshot().items.find(item => item.type === 'userMessage').attachments.length, 1);
      checks.push('real native Haiku retry from explicitly synthetic stored source through packaged UI; original input/file reference restored; one prompt only; source unchanged');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await chat.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await page.screenshot({ path: path.join(root, '.cache/claude-message-actions-live-retry.png') });
      console.log(`PASS: ${checks.join('; ')}. This run: ${prompts}; shared authorized budget: ${alreadySpent + prompts}/${maximumAllowed}.`);
    } else if (actionsOnly) {
      stage = 'native initial answer and file reference';
      const box = await input.boundingBox();
      await page.evaluate(detail => window.dispatchEvent(new CustomEvent('mrmak-file-drop', { detail })), { phase: 'drop', paths: [path.join(repo, 'fixture.txt')], x: box.x + 5, y: box.y + 5 });
      await expect.poll(() => runtime.attachments.length).toBe(1);
      await send('Reply exactly MIK_OK.'); await settle();
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true }).last()).toContainText('MIK_OK');
      const sourceNativeId = runtime.session.nativeId, sourceCount = runtime.snapshot().items.length;
      await input.fill('Keep original draft'); await expect.poll(() => runtime.draft).toBe('Keep original draft');
      stage = 'native branch from response through packaged UI';
      await chat.getByRole('button', { name: 'Branch from this response', exact: true }).last().click();
      await expect(page.locator('.chat-tab.selected')).toContainText('Branch', { timeout: 20000 });
      const branch = service.sessions.active().find(item => item.messageOrigin?.kind === 'branch');
      assert.ok(branch); assert.notEqual(branch.nativeId, sourceNativeId);
      assert.equal(prompts, 1); assert.equal(service.sessions.get(branch.id).graphical.snapshot().items.length, sourceCount);
      checks.push('native SDK branch from response through packaged UI with preserved source/file reference and no inference');
      const sourceRuntime = runtime;
      const focusSource = async () => {
        const response = await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(response.ok, true); await page.reload();
      };
      await focusSource(); stage = 'edit first native input in fresh branch';
      await chat.getByRole('button', { name: 'Edit and branch', exact: true }).first().click();
      await expect(input).toHaveValue('Reply exactly MIK_OK.', { timeout: 20000 });
      const edit = service.sessions.active().find(item => item.messageOrigin?.kind === 'edit');
      assert.ok(edit); runtime = service.sessions.get(edit.id).graphical;
      assert.equal(runtime.snapshot().items.length, 0); assert.equal(runtime.attachments.length, 1); assert.equal(prompts, 1);
      await send('Reply exactly RESUME_OK.'); await settle();
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true }).last()).toContainText('RESUME_OK');
      checks.push('edit restored original input/attachment without inference; edited Haiku response completed in new native session');
      await focusSource(); stage = 'single native retry through packaged UI';
      await chat.getByRole('button', { name: 'Retry response in a new chat', exact: true }).last().click();
      await expect(page.locator('.chat-tab.selected')).toContainText('Retry', { timeout: 20000 });
      const retried = service.sessions.active().find(item => item.messageOrigin?.kind === 'retry');
      assert.ok(retried); runtime = service.sessions.get(retried.id).graphical;
      await expect.poll(() => prompts, { timeout: 15000 }).toBe(3); await settle();
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true }).last()).toContainText('MIK_OK');
      assert.equal(sourceRuntime.draft, 'Keep original draft'); assert.equal(sourceRuntime.snapshot().items.length, sourceCount);
      assert.equal(sourceRuntime.session.nativeId, sourceNativeId);
      assert.equal(runtime.session.graphicalModel, model); assert.equal(runtime.session.effort, 'low');
      checks.push('retry issued exactly one new Haiku prompt; source draft/history/native identity unchanged');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await chat.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await page.screenshot({ path: path.join(root, '.cache/claude-message-actions-live-acceptance.png') });
      console.log(`PASS: ${checks.join('; ')}. This run: ${prompts}; shared authorized budget: ${alreadySpent + prompts}/${maximumAllowed}.`);
    } else if (attachmentBatch) {
      stage = 'image paste through packaged composer';
      await input.evaluate(async element => {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 160;
        const context = canvas.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0, 0, 320, 160);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const clipboard = new DataTransfer(); clipboard.items.add(new File([blob], 'synthetic-color.png', { type: 'image/png' }));
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
      });
      await expect.poll(() => runtime.attachments.length).toBe(1);
      await expect(chat.getByLabel('Draft attachments').getByRole('img')).toBeVisible();
      await send('What color is the image? Reply one word.'); await settle();
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true }).last()).toContainText(/red/i);
      assert.equal(runtime.snapshot().items.find(item => item.type === 'userMessage').attachments[0].kind, 'image');
      checks.push('pasted PNG recognized as red by native Haiku; sent image preview and metadata retained');
      stage = 'file drop and draft attachment persistence';
      const rectangle = await input.boundingBox();
      await page.evaluate(detail => window.dispatchEvent(new CustomEvent('mrmak-file-drop', { detail })), { phase: 'drop', paths: [path.join(repo, 'fixture.txt')], x: rectangle.x + 5, y: rectangle.y + 5 });
      await expect.poll(() => runtime.attachments.length).toBe(1);
      await input.fill('Read the attached text file. Reply its word only.');
      await expect.poll(() => runtime.draft).toBe('Read the attached text file. Reply its word only.');
      const count = runtime.snapshot().items.length;
      await service.sessions.remove(session.id);
      const reopened = await fetch(`${service.origin}/api/sessions/${session.id}/resume`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(reopened.ok, true); runtime = service.sessions.get(session.id).graphical;
      assert.equal(runtime.snapshot().items.length, count); assert.deepEqual(runtime.attachments, [path.join(repo, 'fixture.txt')]);
      await page.reload(); await expect(input).toHaveValue('Read the attached text file. Reply its word only.');
      await expect(chat.getByRole('button', { name: 'Remove fixture.txt', exact: true })).toBeVisible();
      await expect(chat.locator('.graphical-sent-attachments img')).toBeVisible();
      checks.push('native resume preserved image history, unsent text and dropped file reference');
      stage = 'native Read of attached synthetic file';
      await send('Read the attached text file. Reply its word only.');
      await expect.poll(() => {
        const request = runtime.snapshot().requests[0];
        if (request) {
          const file = request.input?.file_path;
          const allowed = request.tool === 'Read' && typeof file === 'string' && path.resolve(repo, file) === path.join(repo, 'fixture.txt');
          runtime.answer(request.id, allowed ? 'allow' : 'deny');
          if (!allowed) throw new Error('Unexpected tool denied; stopped without retry.');
        }
        return runtime.snapshot().working;
      }, { timeout: 60000 }).toBe(false);
      await settle();
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true }).last()).toContainText('MIK_READ_OK');
      assert.ok(runtime.snapshot().items.some(item => item.tool === 'Read'));
      assert.deepEqual(runtime.attachments, []);
      checks.push('attached file read by native tool after resume; selected paths consumed once');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await chat.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await page.screenshot({ path: path.join(root, '.cache/claude-attachments-live-acceptance.png') });
      console.log(`PASS: ${checks.join('; ')}. New attachment batch: ${alreadySpent + prompts}/${maximumAllowed} short Haiku prompts.`);
    } else if (args.includes('--controls-only')) {
      stage = 'native controls through packaged UI';
      const settingsFile = path.join(config.profileRoot, 'Claude', 'settings.json');
      const settingsBefore = await readFile(settingsFile, 'utf8').catch(() => null);
      const peer = await service.sessions.create({ agent: 'claude', chatInterface: 'chat', cwd: repo, name: 'Independent settings peer', effort: 'low', graphicalModel: model, bypass: false });
      const peerRuntime = service.sessions.get(peer.id).graphical;
      const choose = async (label, value) => { await chat.getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: value, exact: true }).click(); };
      await choose('Claude reasoning', 'Medium'); await expect.poll(() => runtime.snapshot().effort).toBe('medium');
      assert.equal(peerRuntime.snapshot().effort, 'low');
      await choose('Claude reasoning', 'Low'); await expect.poll(() => runtime.snapshot().effort).toBe('low');
      for (const [label, native] of [['Accept edits', 'acceptEdits'], ['Deny unapproved actions', 'dontAsk'], ['Plan', 'plan']]) {
        await choose('Claude permissions and mode', label); await expect.poll(() => runtime.snapshot().permissionMode).toBe(native);
        assert.equal(peerRuntime.snapshot().permissionMode, 'default');
      }
      checks.push('native effort/permission controls through packaged UI, isolated peer unchanged');
      stage = 'short native Plan turn'; await send('Read fixture.txt. Reply PLAN_OK; stay in Plan.'); await settle();
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true }).last()).toContainText('PLAN_OK');
      assert.equal(runtime.snapshot().permissionMode, 'plan');
      assert.ok(runtime.snapshot().items.some(item => item.tool === 'Read'));
      assert.equal(runtime.snapshot().items.some(item => ['Write', 'Edit'].includes(item.tool)), false);
      assert.equal(await readFile(path.join(repo, 'fixture.txt'), 'utf8'), 'MIK_READ_OK\n');
      checks.push('native Plan turn read synthetic file without edits');
      stage = 'Plan and effort persist on native resume'; const count = runtime.snapshot().items.length;
      await service.sessions.remove(session.id);
      const reopened = await fetch(`${service.origin}/api/sessions/${session.id}/resume`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
      if (!reopened.ok) throw new Error('The packaged resume endpoint rejected this conversation.');
      runtime = service.sessions.get(session.id).graphical;
      assert.equal(runtime.snapshot().permissionMode, 'plan'); assert.equal(runtime.snapshot().effort, 'low'); assert.equal(runtime.snapshot().items.length, count);
      stage = 'restored Plan controls in selected chat';
      await page.reload(); await expect(page.locator('.chat-tab.selected')).toContainText('Isolated live acceptance');
      await expect(chat.getByRole('combobox', { name: 'Claude permissions and mode', exact: true })).toContainText('Plan');
      await choose('Claude permissions and mode', 'Ask'); await expect.poll(() => runtime.snapshot().permissionMode).toBe('default');
      stage = 'short native Ask turn'; await send('Reply exactly MIK_OK.'); await settle();
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true }).last()).toContainText('MIK_OK');
      assert.equal(await readFile(settingsFile, 'utf8').catch(() => null), settingsBefore);
      checks.push('Plan/effort preserved after resume; Ask restored; native settings defaults unchanged');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await chat.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await page.screenshot({ path: path.join(root, '.cache/claude-controls-live-acceptance.png') });
      console.log(`PASS: ${checks.join('; ')}. This run: ${prompts} very short Haiku prompts; cumulative reserved: ${alreadySpent + prompts}/10.`);
    } else {
    stage = 'short native answer'; await send('Reply exactly MIK_OK.'); await settle();
    await expect(chat.getByRole('article', { name: 'Claude response', exact: true }).last()).toContainText('MIK_OK'); checks.push('native answer rendered');
    if (!focusedResume) {
    stage = 'native Read tool'; await send('Read fixture.txt with Read. Reply its word. No other tools.');
    await expect.poll(async () => {
      const request = runtime.snapshot().requests[0];
      if (request) {
        const file = request.input?.file_path;
        const allowed = request.tool === 'Read' && typeof file === 'string' && path.resolve(repo, file) === path.join(repo, 'fixture.txt');
        runtime.answer(request.id, allowed ? 'allow' : 'deny');
        if (!allowed) throw new Error('Unexpected tool denied; live test stopped.');
      }
      return runtime.snapshot().working;
    }, { timeout: 60000 }).toBe(false);
    await settle(); assert.ok(runtime.snapshot().items.some(item => item.tool === 'Read')); checks.push('native Read on a synthetic file');
    stage = 'native user question'; await send('Use AskUserQuestion: choose A or B. Then reply OK.');
    await expect(chat.getByRole('region', { name: 'Agent request', exact: true })).toBeVisible({ timeout: 60000 });
    const request = runtime.snapshot().requests[0];
    if (request?.kind !== 'question') { if (request) runtime.answer(request.id, 'deny'); throw new Error('Native question was not received as expected.'); }
    const question = request.input.questions?.[0]?.question;
    if (!question) throw new Error('Native question has no text.');
    await chat.getByRole('textbox', { name: `${question} · custom answer`, exact: true }).fill('A');
    await chat.getByRole('button', { name: 'Send answers', exact: true }).click(); await settle(); checks.push('native question answered through UI');
    stage = 'native interrupt'; await send('Reply STOP_CHECK.');
    if (runtime.snapshot().canInterrupt) { await runtime.interrupt(); await settle(); checks.push('native interrupt through runtime'); }
    else { await settle(); checks.push('interrupt inconclusive: short answer completed first'); }
    }
    stage = 'native persistent resume'; const count = runtime.snapshot().items.length;
    await service.sessions.remove(session.id); await service.sessions.resume(session.id); runtime = service.sessions.get(session.id).graphical;
    assert.equal(runtime.snapshot().items.length, count); assert.equal(service.sessions.get(session.id).nativeId, session.nativeId);
    await page.reload(); await send('Reply exactly RESUME_OK.'); await settle();
    await expect(chat.getByRole('article', { name: 'Claude response', exact: true }).last()).toContainText('RESUME_OK'); checks.push('native resume and preserved display history');
    if (focusedResume) {
      stage = 'native interrupt'; await send('Reply STOP_CHECK.');
      if (runtime.snapshot().canInterrupt) { await runtime.interrupt(); await settle(); checks.push('native interrupt through runtime'); }
      else { await settle(); checks.push('interrupt inconclusive: short answer completed first'); }
    }
    await page.screenshot({ path: path.join(root, '.cache/claude-portable-live-acceptance.png') });
    console.log(`PASS: ${checks.join('; ')}. User prompts sent: ${prompts}/10. Native model: ${model}.`);
    }
  } catch (error) {
    // Do not print native envelopes, account responses or browser URLs/tokens.
    failure = `Acceptance stopped during ${stage} (${error.name || 'Error'}); no automatic retry.`;
    failureDetail = String(error.message || 'Unknown failure').split('\n')[0].slice(0, 300);
    if (service?.token) failureDetail = failureDetail.replaceAll(service.token, '<redacted>');
    const snapshot = service?.sessions.active().find(item => item.agent === 'claude');
    checks.push(`Failure state: ${snapshot?.status || 'unavailable'} / ${snapshot?.activity || 'unavailable'}`);
    console.error(failure); process.exitCode = 1;
  } finally {
    try { await browser?.close(); await service?.close(); await record(); await cleanupFixtures(); }
    finally { closeSync(lock); unlinkSync(lockPath); for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]; Object.assign(process.env, originalEnv); }
  }
}
