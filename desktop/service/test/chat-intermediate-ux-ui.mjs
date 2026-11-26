// Intermediate execution presentation, compiled UI + isolated provider fixtures.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { ClaudeChat } from '../claude-chat.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-intermediate-ux-')), survey = process.argv.includes('--survey');
const evidence = path.resolve('.cache', survey ? 'intermediate-ux-before' : 'intermediate-ux-after');
const results = [], wires = [];
let browser, service;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  const baseline = process.argv.indexOf('--baseline'), uiDir = baseline < 0 ? path.resolve('dist') : path.join(base, 'ui');
  if (baseline >= 0) {
    const backup = path.resolve(process.argv[baseline + 1]);
    const names = new Set(['GraphicalTimeline.tsx','GraphicalActivityCard.tsx','GraphicalAssets.tsx','GraphicalToolResults.tsx','ChatOutputActions.tsx','ChatRichBlock.tsx','graphical-steps.css','chat-refinements.css','GraphicalOperations.tsx','useChatPreviewPin.ts']);
    await build({ logLevel: 'silent', build: { outDir: uiDir }, plugins: [{ name: 'isolated-previous-ui', enforce: 'pre', async transform(_source, id) { if (id.replaceAll('\\','/').includes('/src/desktop/') && names.has(path.basename(id))) return readFile(path.join(backup, path.basename(id)), 'utf8'); } }] });
    await cp(path.resolve('public/assets'), path.join(uiDir, 'assets'), { recursive: true });
  }
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  const imagePath = path.join(repo, 'sample.png'), sourcePath = path.join(repo, 'artifacts', 'CatalogReview', 'InspectCatalog.cs');
  await mkdir(path.dirname(sourcePath), { recursive: true }); await writeFile(sourcePath, '// Synthetic file');
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
  service = await createService({ repo, uiDir, mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Synthetic intermediate UX'), wire = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => {
    if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: wire.spawnChild });
    const fixture = claudeFixture(options.session.nativeId); wires.push(fixture); return new ClaudeChat({ ...options, transportFactory: fixture.factory });
  };
  browser = await chromium.launch({ headless: true, channel: 'chrome', env: testBrowserEnvironment() });
  const context = await browser.newContext({ viewport: { width: 560, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const preview = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 160;
    const painter = canvas.getContext('2d'); painter.fillStyle = '#20242c'; painter.fillRect(0, 0, 320, 160);
    painter.fillStyle = '#c4cbd5'; painter.font = '18px sans-serif'; painter.fillText('Synthetic preview', 28, 88);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await writeFile(imagePath, Buffer.from(preview, 'base64'));
  for (const agent of ['codex', 'claude']) {
    const session = await service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, accountProfileId: agent === 'codex' ? profile.id : undefined });
    const runtime = service.sessions.get(session.id).graphical;
    runtime.previewPaths.add(imagePath);
    const items = [
      { id: 'question', type: 'userMessage', text: 'Inspect the catalog and report the result.' },
      { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'I compare the catalog definitions.\n\n```typescript\nconst current = catalog.entries;\n```\n\nI am checking the serialized fields.' },
      { id: 'empty', type: 'agentMessage', phase: 'commentary', text: '' },
      { id: 'command', type: 'commandExecution', text: 'dotnet test --no-build', details: 'Tests passed', exitCode: 0, durationMs: 2700 },
      { id: 'change', type: 'fileChange', changes: [{ path: sourcePath, kind: 'add', diff: '@@ -0,0 +1,3 @@\n+var entries = catalog.Entries;\n+foreach (var entry in entries)\n+    Console.WriteLine(entry.Name);' }] },
      { id: 'image', type: 'imageGeneration', path: imagePath },
      { id: 'review', type: 'exitedReviewMode', text: JSON.stringify({ findings: [{ title: '[P2] Check serialization', body: 'Keep the **field order** stable.', code_location: { absolute_file_path: sourcePath, line_range: { start: 1, end: 2 } } }] }) },
    ].map(item => ({ details: '', status: 'completed', turnId: 'ux-turn', ...item }));
    if (agent === 'claude') {
      const image = items.find(item => item.id === 'image');
      Object.assign(image, { type: 'agentMessage', phase: 'commentary', path: undefined, text: '', attachments: [{ path: imagePath, name: 'Intermediate image', kind: 'image' }] });
    }
    const turn = { id: 'ux-turn', status: 'inProgress', startedAt: Date.now() - 56000, completedAt: null, durationMs: null, timingSource: 'observed' };
    const update = active => {
      if (agent === 'codex') { runtime.items = new Map(items.map(item => [item.id, { ...item }])); runtime.turns = new Map([[turn.id, { ...turn }]]); runtime.turnId = active ? turn.id : null; }
      else Object.assign(runtime.protocol.state, { items: structuredClone(items), turns: [structuredClone(turn)], status: active ? 'running' : 'ready' });
      runtime.changed();
    };
    update(true);
    await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    await page.goto(service.urls.chats);
    const chat = page.getByRole('region', { name: `${agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true });
    const processGroup = chat.locator('.graphical-turn-process'); await expect(processGroup).toBeVisible();
    const check = (name, passed, value) => results.push({ agent, name, passed, ...(value != null ? { value } : {}) });
    check('working turn automatically shows intermediate steps', await processGroup.evaluate(node => node.open));
    if (!await processGroup.evaluate(node => node.open)) await processGroup.locator(':scope > summary').click();
    await processGroup.locator(':scope > summary').click(); update(true); await page.waitForTimeout(100);
    check('manual closing while working survives updates', !await processGroup.evaluate(node => node.open));
    await processGroup.locator(':scope > summary').click();
    for (const group of await chat.locator('.graphical-work-group').all()) if (!await group.evaluate(node => node.open)) await group.locator(':scope > summary').click();
    const file = chat.locator('[data-chat-item="change"] .graphical-file-change'); await file.locator(':scope > summary').click();
    await expect(chat.getByRole('button', { name: 'Save chat image', exact: true })).toBeAttached();
    const download = page.waitForEvent('download'); await chat.getByRole('button', { name: 'Save chat image', exact: true }).click();
    check('minimal image save downloads a PNG', /\.png$/i.test((await download).suggestedFilename()));
    check('no empty progress placeholders', await chat.locator('[data-chat-item="empty"]').count() === 0);
    check('no workspace/card exports in intermediate output', await processGroup.locator('[aria-label*="Workspace"],[aria-label="Add output to card"]').count() === 0);
    check('no file save in intermediate changes', await file.getByRole('button', { name: /^Save / }).count() === 0);
    check('no intermediate quote or inspector actions', await processGroup.locator('[aria-label="Quote message"]').count() === 0 && await processGroup.getByRole('button', { name: /Inspect (changes|review)/ }).count() === 0);
    const rich = processGroup.locator('.chat-rich-block');
    check('rich intermediate blocks keep copy but remove downloads', await rich.getByRole('button', { name: 'Copy code', exact: true }).count() === 1 && await rich.getByRole('button', { name: 'Download code', exact: true, includeHidden: true }).count() === 0);
    const progress = chat.locator('[data-chat-item="progress"]');
    const gap = await progress.evaluate(element => { const last = [...element.querySelectorAll('.chat-prose > p')].at(-1); const next = element.parentElement.querySelector('.graphical-work-group > summary'); return last && next ? next.getBoundingClientRect().top - last.getBoundingClientRect().bottom : -1; });
    check('compact gap from commentary to activities', gap >= 0 && gap <= 28, gap);
    check('compact file heading', await file.locator(':scope > summary').evaluate(node => node.getBoundingClientRect().height <= 28));
    await file.screenshot({ path: path.join(evidence, `${agent}-file.png`) });
    await chat.locator('.graphical-image').hover();
    await chat.locator('.graphical-image').screenshot({ path: path.join(evidence, `${agent}-image.png`) });
    await processGroup.screenshot({ path: path.join(evidence, `${agent}-expanded.png`) });
    await chat.getByRole('button', { name: 'Expand image', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true }); await expect(viewer).toBeVisible();
    turn.status = 'completed'; turn.completedAt = Date.now(); turn.durationMs = 56000;
    items.push({ id: 'final', type: 'agentMessage', phase: 'final_answer', text: '## Result\n\nThe catalog is verified.\n\n```typescript\nconst verified = true;\n```', details: '', status: 'completed', turnId: turn.id }); update(false);
    await expect(chat.getByRole('heading', { name: 'Result', exact: true })).toBeVisible();
    await expect(processGroup.locator(':scope > summary')).toContainText('Worked');
    if (!survey) await expect(processGroup).not.toHaveAttribute('open');
    check('completed turn automatically compacts intermediate steps', !await processGroup.evaluate(node => node.open));
    check('completion preserves an image already open in the viewer', await viewer.isVisible());
    if (await viewer.isVisible()) await viewer.getByRole('button', { name: 'Close image', exact: true }).click();
    check('closing the viewer does not reopen the completed log', !await processGroup.evaluate(node => node.open));
    if (!await processGroup.evaluate(node => node.open)) await processGroup.locator(':scope > summary').click();
    update(false); await page.waitForTimeout(100);
    check('manual reopening survives late settled updates', await processGroup.evaluate(node => node.open));
    check('no message add-to-card after completion inside steps', await processGroup.getByRole('button', { name: 'Add to card', exact: true }).count() === 0);
    const final = chat.locator('[data-chat-item="final"]');
    check('final output retains its workspace/card actions', await final.getByRole('button', { name: 'Open code in Workspace', exact: true }).count() === 1 && await final.getByRole('button', { name: 'Add to card', exact: true }).count() === 1);
    for (const width of [320, 390, 560, 1100]) { await page.setViewportSize({ width, height: 1000 }); check(`no overflow ${width}`, await chat.evaluate(node => node.scrollWidth <= node.clientWidth + 1)); }
    await page.setViewportSize({ width: 560, height: 1000 });
    if (await processGroup.evaluate(node => node.open)) await processGroup.locator(':scope > summary').click();
    await chat.screenshot({ path: path.join(evidence, `${agent}-complete.png`) });
  }
  assert.deepEqual(errors, []); assert.ok(!wire.calls.some(call => call.method === 'turn/start'));
  await writeFile(path.join(evidence, 'checks.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
  if (!survey) assert.ok(results.every(entry => entry.passed));
} finally { await browser?.close(); await service?.close(); for (const wire of wires) await wire.close(); await cleanupFixtures(); }
