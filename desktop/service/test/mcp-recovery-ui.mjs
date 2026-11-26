import { testBrowserEnvironment } from './fixtures.mjs';
// Production UI acceptance with synthetic native configuration only.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { build } from 'vite';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await mkdtemp(path.join(root, '.cache/mcp-recovery-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), projectRoot = path.join(base, 'project'), home = path.join(base, 'home'), uiDir = path.join(base, 'ui');
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: uiDir, emptyOutDir: false } });
  for (const folder of [path.join(repo, 'workspace'), path.join(projectRoot, '.codex'), path.join(home, '.codex')]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const localFile = path.join(projectRoot, '.codex/config.toml'), globalFile = path.join(home, '.codex/config.toml');
  const local = '# preserve this comment\n[mcp_servers.demo]\ncommand="C:/missing/fixture-mcp.exe"\n';
  const global = '[mcp_servers.demo]\nurl="https://example.invalid/mcp"\nhttp_headers={Authorization="fixture-secret"}\n';
  await writeFile(localFile, local); await writeFile(globalFile, global);
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { demo: { type: 'http', url: 'https://example.invalid' } }, projects: { [projectRoot]: { mcpServers: { demo: { command: 'missing-claude-fixture' } } } } }));
  await mkdir(path.join(home, '.config/opencode'), { recursive: true });
  await writeFile(path.join(home, '.config/opencode/opencode.json'), JSON.stringify({ mcp: { servers: { demo: { type: 'remote', url: 'https://example.invalid', oauth: false } } } }));
  const openCodeFile = path.join(projectRoot, 'opencode.jsonc');
  await writeFile(openCodeFile, '// retained UI comment\n' + JSON.stringify({ mcp: { servers: { demo: { type: 'local', command: ['missing-opencode-fixture'] } } } }));
  service = await createService({ repo, uiDir, mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex') } }, profileOptions: { root: path.join(base, 'accounts') } });
  const project = await service.projects.save({ name: 'Recovery fixture', repositoryPath: projectRoot });
  await fetch(`${service.origin}/api/settings`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ selectedProjectId: project.id }) });
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  await page.getByRole('button', { name: 'Toggle mcp' }).click();
  const card = page.locator('[data-mcp-id="codex:demo"]');
  await expect(card.getByText('Invalid configuration', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Check demo for Codex', exact: true })).toBeDisabled();
  const openDetails = async agent => {
    await page.locator(`[data-mcp-id="${agent}:demo"]`).getByRole('button', { name: 'Details for demo', exact: true }).click();
    return page.getByRole('dialog', { name: 'Details for demo', exact: true });
  };
  let detail = await openDetails('codex');
  await detail.getByRole('button', { name: 'Use global configuration' }).click();
  const review = detail.getByRole('group', { name: 'Review recovery for demo' });
  await expect(review).toBeVisible();
  assert.ok(!(await review.textContent()).includes('fixture-secret'));
  assert.equal(await readFile(localFile, 'utf8'), local);
  await review.getByRole('button', { name: 'Cancel' }).click();
  await detail.getByRole('button', { name: 'Close tool details', exact: true }).click();
  for (const agent of ['claude', 'opencode', 'codex']) {
    detail = await openDetails(agent);
    await detail.getByRole('button', { name: 'Use global configuration' }).click();
    await detail.getByRole('group', { name: 'Review recovery for demo' }).getByRole('button', { name: 'Confirm recovery' }).click();
    await expect(detail.getByRole('button', { name: 'Undo recovery' })).toBeVisible();
    if (agent === 'codex') {
      assert.equal(await readFile(globalFile, 'utf8'), global);
      assert.ok(!(await readFile(localFile, 'utf8')).includes('fixture-mcp.exe'));
    }
    // Closing a details popup must not discard the only Undo action.
    await detail.getByRole('button', { name: 'Close tool details', exact: true }).click();
    detail = await openDetails(agent);
    await expect(detail.getByRole('button', { name: 'Undo recovery' })).toBeVisible();
    await detail.getByRole('button', { name: 'Undo recovery' }).click();
    await expect(detail.getByRole('button', { name: 'Use global configuration' })).toBeVisible();
    await detail.getByRole('button', { name: 'Close tool details', exact: true }).click();
  }
  assert.equal(await readFile(localFile, 'utf8'), local);
  await writeFile(localFile, '[broken');
  await page.getByRole('button', { name: 'Refresh MCP configurations' }).click();
  await page.getByRole('button', { name: 'Diagnostics', exact: false }).click();
  await expect(page.locator('.mcp-problem').filter({ hasText: 'Configuration could not be read' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use global configuration' })).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.equal(service.sessions.list().length, 0);
  assert.equal(service.coordinator.child, null);
  console.log('PASS: isolated Tools UI reviews, cancels, applies and undoes Codex recovery, keeps secrets hidden and shows malformed-config diagnostics without starting an agent.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
