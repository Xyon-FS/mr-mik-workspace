import { testBrowserEnvironment } from './fixtures.mjs';
// Focused production UI + asset-route acceptance; synthetic tool responses only.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-tool-interactions-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'), native = path.join(home, '.codex');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(native, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}'); await writeFile(path.join(native, 'config.toml'), '# Synthetic\n');
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { ...process.env, CODEX_HOME: native } }, profileOptions: { root: path.join(base, 'accounts') } });
  const profile = await service.profiles.create('Tool fixture');
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const transport = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
  const session = await service.sessions.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: profile.id, codexPermissions: 'ask', cwd: repo });
  const runtime = service.sessions.get(session.id).graphical, child = transport.children[0];
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' }); const page = await browser.newPage();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: 'Codex graphical chat', exact: true }); await expect(chat).toBeVisible();
  child.request(801, 'mcpServer/elicitation/request', { threadId: runtime.threadId, serverName: 'fixture', mode: 'form', message: 'Choose export options', requestedSchema: { type: 'object', required: ['name', 'confirm'], properties: { name: { type: 'string', title: 'Export name', minLength: 2 }, confirm: { type: 'boolean', title: 'Include notes' }, count: { type: 'integer', title: 'Copies', default: 2, minimum: 1 } } } });
  const request = chat.getByRole('region', { name: 'Agent request', exact: true });
  await request.getByRole('button', { name: 'Send response', exact: true }).click(); await expect(request.getByRole('alert')).toHaveCount(2);
  await request.getByRole('textbox', { name: 'Export name', exact: true }).fill('Report');
  await request.getByRole('combobox', { name: 'Include notes', exact: true }).click(); await page.getByRole('option', { name: 'No', exact: true }).click();
  await request.getByRole('button', { name: 'Send response', exact: true }).click();
  await expect(request.getByText('Response sent · waiting for Codex', { exact: true })).toBeVisible();
  assert.deepEqual(transport.calls.find(call => call.id === 801 && !call.method).result.content, { name: 'Report', confirm: false, count: 2 });
  child.notify('serverRequest/resolved', { threadId: runtime.threadId, requestId: 801 });
  child.request(802, 'mcpServer/elicitation/request', { threadId: runtime.threadId, serverName: 'fixture', mode: 'form', message: 'Unsupported form', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } });
  await expect(request.getByText(/unsupported form.*Decline or cancel/)).toBeVisible(); await expect(request.getByRole('button', { name: 'Send response', exact: true })).toHaveCount(0);
  await request.getByRole('button', { name: 'Cancel request', exact: true }).click(); child.notify('serverRequest/resolved', { threadId: runtime.threadId, requestId: 802 });
  const outside = path.join(base, 'private.wav'); await writeFile(outside, 'Synthetic');
  for (let index = 0; index < 40; index++) runtime.upsert({ id: `earlier-${index}`, type: 'agentMessage', text: `Earlier tool response ${index}`, status: 'completed' }, { turnId: `earlier-${index}` });
  const wave = Buffer.alloc(44 + 8 * 8000);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(8000, 28); wave.writeUInt16LE(1, 32);
  wave.writeUInt16LE(8, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  wave.fill(128, 44);
  runtime.upsert({ id: 'result', type: 'mcpToolCall', status: 'completed', tool: 'preview_fixture', result: { content: [
    { type: 'audio', name: 'Sound', mimeType: 'audio/wav', data: wave.toString('base64') },
    { type: 'resource', resource: { uri: 'tool://video', name: 'Clip', mimeType: 'video/mp4', blob: 'AAAAAA==' } },
    { type: 'resource', resource: { uri: 'tool://html', name: 'HTML', mimeType: 'text/html', text: '<script>window.toolExecuted=true</script>' } },
    { type: 'image', name: 'Picture.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' },
    { type: 'resource_link', name: 'Private', uri: outside, mimeType: 'audio/wav' },
    { type: 'resource_link', name: 'External', uri: 'https://example.invalid/resource' },
  ] } }, { turnId: 'media-result' }); runtime.changed();
  await chat.locator('details.graphical-turn-process > summary').click();
  await chat.getByText('1 activity', { exact: true }).click();
  const sound = chat.getByRole('region', { name: 'Tool result: Sound', exact: true });
  await sound.getByRole('button', { name: 'Preview', exact: true }).click(); await expect(sound.locator('audio')).toHaveAttribute('src', /^blob:/);
  const audio = sound.locator('audio');
  await audio.evaluate(async element => { element.muted = true; await element.play(); });
  await chat.locator('.graphical-messages').evaluate(element => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200 })); element.scrollTop = 0; });
  await expect(chat.getByText('Earlier tool response 0', { exact: true })).toBeInViewport();
  await expect.poll(() => audio.evaluate(element => !element.paused && element.currentTime > 0)).toBe(true);
  await audio.evaluate(element => element.pause());
  await chat.getByRole('button', { name: /Back to latest/ }).click();
  const clip = chat.getByRole('region', { name: 'Tool result: Clip', exact: true }); await clip.getByRole('button', { name: 'Preview', exact: true }).click(); await expect(clip.locator('video')).toHaveAttribute('src', /^blob:/);
  await expect(chat.getByRole('region', { name: 'Tool result: HTML', exact: true }).locator('pre')).toHaveText('<script>window.toolExecuted=true</script>'); assert.equal(await page.evaluate(() => window.toolExecuted), undefined);
  const privateCard = chat.getByRole('region', { name: 'Tool result: Private', exact: true }); await privateCard.getByRole('button', { name: 'Preview', exact: true }).click(); await expect(privateCard.getByRole('alert')).toContainText('outside the chat preview');
  await expect(chat.getByRole('link', { name: 'Open resource', exact: true })).toHaveAttribute('href', 'https://example.invalid/resource');
  await expect(sound.getByRole('button', { name: 'Save file', exact: true })).toHaveCount(0);
  const textCard = chat.getByRole('region', { name: 'Tool result: HTML', exact: true });
  await textCard.getByRole('button', { name: 'Copy tool text', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '<script>window.toolExecuted=true</script>');
  const picture = chat.getByRole('region', { name: 'Tool result: Picture.png', exact: true });
  const download = page.waitForEvent('download'); await picture.getByRole('button', { name: 'Save tool image', exact: true }).click(); assert.equal((await download).suggestedFilename(), 'Picture.png');
  await page.setViewportSize({ width: 430, height: 850 }); assert.ok(await chat.evaluate(element => element.scrollWidth <= element.clientWidth));
  assert.deepEqual(errors, []);
  console.log('PASS: validated MCP form, false/default values, unsupported cancellation, typed audio/video, inert HTML, external link, intermediate download restrictions and local scope denial. No model/login/user Hub.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
