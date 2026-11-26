// Production browser/service acceptance. Synthetic transports, no user Hub or inference.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
const root = path.resolve('.'), base = await mkdtemp(path.join(os.tmpdir(), 'mik-preview-consistency-'));
const at = process.argv.indexOf('--portable'), portable = at < 0 ? null : path.resolve(process.argv[at + 1]);
const serviceRoot = portable ? path.join(portable, 'App/runtime/service') : path.join(root, 'desktop/service');
const { createService: factory } = await import(pathToFileURL(path.join(serviceRoot, 'server.mjs')));
const { CodexChat } = await import(pathToFileURL(path.join(serviceRoot, 'codex-chat.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
let service, browser; const wires = [];
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir: portable ? path.join(portable, 'App/runtime/ui') : path.join(root, 'dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Preview fixture'), transport = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => { if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: transport.spawnChild }); const wire = claudeFixture(options.session.nativeId); wires.push(wire); return new ClaudeChat({ ...options, transportFactory: wire.factory }); };
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const context = await browser.newContext({ viewport: { width: 1000, height: 850 } }); context.setDefaultTimeout(30000);
  await context.addInitScript(() => { window.previewCopies = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.previewCopies.push(text), write: async values => window.previewCopies.push(values[0].types) } }); });
  const page = await context.newPage(), workspace = await context.newPage(), errors = [];
  for (const tab of [page, workspace]) tab.on('pageerror', error => errors.push(error.message));
  await workspace.goto(service.urls.workspace);
  const image = path.join(repo, 'diagram.png'), png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 800; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4567a0'; ctx.fillRect(0, 0, 1000, 800); return canvas.toDataURL('image/png').split(',')[1]; });
  await writeFile(image, Buffer.from(png, 'base64'));
  const generated = path.join(home, '.codex/generated_images/generated.png'); await mkdir(path.dirname(generated), { recursive: true }); await writeFile(generated, Buffer.from(png, 'base64'));
  const jpeg = path.join(repo, 'sample.jpg'), jpegBytes = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600; return canvas.toDataURL('image/jpeg').split(',')[1]; }); await writeFile(jpeg, Buffer.from(jpegBytes, 'base64'));
  const pdfObjects = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Count 2/Kids[3 0 R 5 0 R]>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]/Resources<</Font<</F1 7 0 R>>>>/Contents 4 0 R>>', '<</Length 42>>\nstream\nBT /F1 18 Tf 30 350 Td (Page one) Tj ET\nendstream', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]/Resources<</Font<</F1 7 0 R>>>>/Contents 6 0 R>>', '<</Length 42>>\nstream\nBT /F1 18 Tf 30 350 Td (Page two) Tj ET\nendstream', '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0]; for (const [index, object] of pdfObjects.entries()) { const stream = /stream\n([\s\S]*?)endstream/.exec(object); const rendered = stream ? object.replace('/Length 42', `/Length ${Buffer.byteLength(stream[1])}`) : object; offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${rendered}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer<</Size 8/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  for (let index = 0; index < 4; index++) await writeFile(path.join(repo, `sample-${index}.pdf`), pdf);
  const openImageInWorkspace = async image => {
    await image.getByRole('button', { name: 'Artifact actions', exact: true }).click();
    await page.getByRole('dialog', { name: 'Artifact actions', exact: true }).getByRole('button', { name: 'Open output in Workspace', exact: true }).click();
  };
  const code = Array.from({ length: 100 }, (_, index) => `const value${index} = ${index};`).join('\n');
  for (const agent of ['codex', 'claude']) {
    const session = await service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, name: `${agent} previews`, accountProfileId: agent === 'codex' ? profile.id : undefined }), runtime = service.sessions.get(session.id).graphical;
    const text = `\`\`\`typescript\n${code}\n\`\`\`\n\n|Name|Value|\n|---|---|\n|A|value "quoted"|\n\n\`\`\`mermaid\ngraph TD\nA[Chat] --> B[Workspace]\n\`\`\`\n\n${[0, 1, 2, 3].map(index => `[PDF ${index}](${pathToFileURL(path.join(repo, `sample-${index}.pdf`)).href})`).join(' ')}\n\n\`\`\`html\n<script>window.previewExecuted=true</script>\n\`\`\`\n\n![JPEG preview](${service.files.url(jpeg)})`;
    const citation = `Fonte: :codex-file-citation{path="${path.join(repo,'sample-0.pdf').replaceAll('\\','/')}" purpose="source"}`;
    const item = { id: `${agent}-preview`, type: 'agentMessage', turnId: 'preview-turn', text:text+'\n\n'+citation, details: '', status: 'completed', attachments: [{ path: image, name: 'Diagram', kind: 'image' }] }, turn = { id: 'preview-turn', status: 'completed', timingSource: 'unavailable' };
    const cached = { id: 'native-cache-image', turnId: 'cached-turn', type: agent === 'codex' ? 'imageGeneration' : 'agentMessage', text: agent === 'claude' ? 'An explicitly attached external image.' : '', details: '', status: 'completed', path: generated, ...(agent === 'claude' ? { attachments: [{ path: generated, name: 'Generated', kind: 'image' }] } : {}) }; runtime.previewPaths.add(await realpath(generated));
    if (agent === 'codex') { runtime.items = new Map([[item.id, item], [cached.id, cached]]); runtime.turns = new Map([[turn.id, turn]]); } else Object.assign(runtime.protocol.state, { items: [item, cached], turns: [turn], status: 'ready' }); runtime.changed();
    await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    await page.goto(service.urls.chats);
    const chat = page.getByRole('region', { name: `${agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true }), answer = chat.locator(`[data-chat-item="${item.id}"]`), block = answer.locator('.graphical-code').first();
    const active = workspace.locator('.workspace-preview-slot:not([hidden]) .file-preview');
    const source=answer.getByRole('link',{name:'sample-0.pdf',exact:true});await expect(source).toBeVisible();await expect(source).toHaveClass(/chat-file-citation/);await expect(source).toHaveAttribute('title',path.join(repo,'sample-0.pdf').replaceAll('\\','/'));await source.click();await expect(active.locator('iframe')).toHaveAttribute('title','sample-0.pdf');await expect(answer).not.toContainText(':codex-file-citation');await page.screenshot({path:path.join(root,`.cache/${agent}-file-source-link.png`)});
    await expect(block).toBeVisible(); const draft = chat.locator('textarea').first(); await draft.fill('Keep my draft');
    await block.getByRole('button', { name: 'Copy code', exact: true }).click(); assert.equal(await page.evaluate(() => window.previewCopies.at(-1)), code);
    const downloaded = page.waitForEvent('download'); await block.getByLabel('Output options', { exact: true }).click(); await page.getByRole('dialog', { name: 'Output options', exact: true }).getByRole('button', { name: 'Download code', exact: true }).click(); assert.equal((await downloaded).suggestedFilename(), 'code.ts');
    await block.getByRole('button', { name: 'Open code in Workspace' }).click(); await expect(active.locator('pre')).toContainText('value99');
    await expect(active.getByRole('button', { name: 'Source chat', exact: true })).toBeVisible();
    await active.locator(':scope > header').getByRole('button', { name: 'Expand', exact: true }).click(); await expect.poll(() => workspace.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await expect(block.getByRole('button', { name: 'Expand code', exact: true })).toHaveCount(0);
    const table = answer.locator('.chat-rich-table'); await table.getByRole('button', { name: 'Open table in Workspace' }).click(); await expect(active.locator('td').last()).toHaveText('value "quoted"'); await expect.poll(() => workspace.evaluate(() => !!document.fullscreenElement)).toBe(false);
    const csvDownload = workspace.waitForEvent('download'); await active.getByLabel('Output options', { exact: true }).click(); await workspace.getByRole('dialog', { name: 'Output options', exact: true }).getByRole('button', { name: 'Download table' }).click(); const csv = await csvDownload; assert.equal(csv.suggestedFilename(), 'table.csv');
    const stream = await csv.createReadStream(); let csvText = ''; for await (const chunk of stream) csvText += chunk.toString(); assert.ok(csvText.includes('"value ""quoted"""'));
    await answer.locator('.graphical-code').nth(1).getByRole('button', { name: 'Open code in Workspace' }).click(); await expect(active.locator('[data-streamdown="mermaid-block"] svg')).toBeVisible({ timeout: 20000 });
    const diagram = workspace.waitForEvent('download'); await active.getByLabel('Output options', { exact: true }).click(); await workspace.getByRole('dialog', { name: 'Output options', exact: true }).getByRole('button', { name: 'Download code' }).click(); assert.equal((await diagram).suggestedFilename(), 'diagram.svg');
    await answer.locator('.graphical-code').last().getByRole('button', { name: 'Open code in Workspace' }).click(); await expect(active.locator('pre')).toContainText('<script>'); assert.equal(await workspace.evaluate(() => !!window.previewExecuted), false);
    await answer.getByRole('button', { name: 'Expand image', exact: true }).click(); const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true }); await viewer.getByRole('button', { name: 'Actual image size' }).click(); await viewer.getByRole('button', { name: 'Zoom in' }).click(); await expect(viewer.getByRole('status', { name: 'Image zoom' })).toHaveText('125%');
    await viewer.getByRole('button', { name: 'Copy image' }).click(); await expect(viewer).toContainText('Image copied'); assert.deepEqual(await page.evaluate(() => window.previewCopies.at(-1)), ['image/png']);
    const pngDownload = page.waitForEvent('download'); await viewer.getByRole('link', { name: 'Save image', exact: true }).click(); const pngStream = await (await pngDownload).createReadStream(), parts = []; for await (const part of pngStream) parts.push(part); assert.deepEqual(Buffer.concat(parts), Buffer.from(png, 'base64'));
    await viewer.locator('.chat-image-canvas').evaluate(element => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true })); element.scrollTop = 100; element.scrollLeft = 120; });
    await page.keyboard.press('Escape'); await answer.getByRole('button', { name: 'Expand image', exact: true }).click(); await expect(viewer.getByRole('status', { name: 'Image zoom' })).toHaveText('125%'); await expect.poll(() => viewer.locator('.chat-image-canvas').evaluate(element => element.scrollLeft)).toBe(120); await page.keyboard.press('Escape');
    await openImageInWorkspace(answer.locator('.graphical-image')); await expect(active.locator('.file-preview-body.image img')).toBeVisible();await expect(active.locator(':scope > header').getByRole('button',{name:'Expand',exact:true})).toHaveAttribute('title','Expand image'); await active.locator(':scope > header').getByRole('button',{name:'Expand',exact:true}).click();
    const workspaceImage = workspace.getByRole('dialog', { name: 'Image preview', exact: true }); await expect(workspaceImage.getByRole('status', { name: 'Image zoom' })).toHaveText('125%'); await expect.poll(() => workspaceImage.locator('.chat-image-canvas').evaluate(element => element.scrollLeft)).toBe(120); await workspaceImage.getByRole('button', { name: 'Copy image' }).click(); await expect(workspaceImage).toContainText('Image copied'); await workspace.keyboard.press('Escape');await active.getByRole('link',{name:'Expand image',exact:true}).click();await expect(workspaceImage.getByRole('status',{name:'Image zoom'})).toHaveText('125%');await expect.poll(()=>workspaceImage.locator('.chat-image-canvas').evaluate(element=>element.scrollLeft)).toBe(120);assert.equal(await workspace.evaluate(()=>!!document.fullscreenElement),false);await workspace.keyboard.press('Escape');
    await answer.getByRole('link', { name: 'Expand image', exact: true }).click(); const jpegViewer = page.getByRole('dialog', { name: 'Image preview', exact: true }); await jpegViewer.getByRole('button', { name: 'Copy image' }).click(); await expect(jpegViewer).toContainText('Image copied');
    const jpegDownload = page.waitForEvent('download'); await jpegViewer.getByRole('link', { name: 'Save image', exact: true }).click(); assert.equal((await jpegDownload).suggestedFilename(), 'sample.jpg'); await page.keyboard.press('Escape');
    await openImageInWorkspace(chat.locator('[data-chat-item="native-cache-image"] .graphical-image')); await expect(active.locator('.file-preview-body.image img')).toHaveAttribute('alt', 'generated.png');
    await answer.getByRole('link', { name: 'PDF 0', exact: true }).click(); const frame = active.locator('iframe'); await expect(frame).toBeVisible(); await frame.evaluate(element => { element.dataset.keepalive = 'retained'; });
    await workspace.getByRole('button', { name: 'Close file preview' }).click(); await block.getByRole('button', { name: 'Open code in Workspace' }).click(); await expect(active.locator('pre')).toContainText('value99'); await answer.getByRole('link', { name: 'PDF 0', exact: true }).click(); await expect(active.locator('iframe')).toHaveAttribute('data-keepalive', 'retained');
    await writeFile(path.join(repo, 'sample-0.pdf'), `${pdf}\n% Updated ${agent}`); await answer.getByRole('link', { name: 'PDF 0', exact: true }).click(); await expect(active.locator('iframe')).not.toHaveAttribute('data-keepalive', 'retained'); await active.locator('iframe').evaluate(element => { element.dataset.eviction = 'evict-me'; });
    for (const index of [1, 2, 3]) { await answer.getByRole('link', { name: `PDF ${index}`, exact: true }).click(); await expect(active.locator('iframe')).toHaveAttribute('title', `sample-${index}.pdf`); await page.waitForTimeout(80); }
    await expect.poll(() => workspace.locator('.workspace-preview-slot iframe').count()).toBeLessThan(4);
    await answer.getByRole('link', { name: 'PDF 0', exact: true }).click(); await expect(active.locator('iframe')).not.toHaveAttribute('data-eviction', 'evict-me');
    await page.setViewportSize({ width: 390, height: 844 }); await block.getByRole('button', { name: 'Open code in Workspace' }).click(); await expect(active.locator('pre')).toContainText('value99'); assert.ok(await chat.evaluate(element => element.scrollWidth <= element.clientWidth + 1)); await page.screenshot({ path: path.join(root, `.cache/${agent}-preview-consistency.png`) }); await expect(draft).toHaveValue('Keep my draft'); await page.setViewportSize({ width: 1000, height: 850 });
  }
  assert.deepEqual(errors, []); assert.equal(transport.calls.some(call => call.method === 'turn/start'), false); assert.equal(wires.flatMap(wire => wire.calls).some(call => call.type === 'user'), false);
  console.log('PASS Codex/Claude preview UX: code/table/diagram Workspace views, safe HTML source, copy/download, CSV quoting, Workspace-only block navigation, shared image zoom/copy/transfer, PDF keepalive/eviction, focus/draft and narrow layout. Zero model prompts.');
} finally { await browser?.close(); await service?.close(); for (const wire of wires) wire.close(); await cleanupFixtures(); }
