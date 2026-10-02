import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = name => readFile(new URL(`../../../${name}`, import.meta.url), 'utf8');

test('current Help describes shipped OpenCode support, core defaults, protected refresh and transfer limits', async () => {
  const guide = await source('docs/user-guide.md');
  assert.doesNotMatch(guide, /unreleased|Full V2 chat transfer remains unfinished|Native skill reload is not part|Published 0\.2\.7 downloads/i);
  for (const text of ['## OpenCode V1/V2', '**V2 conversation transfer:**', 'workspace-authoring and feature-handoff', 'protected same-conversation resume', 'Unavailable conversations: partial full transfer', 'Revert state, cross-folder', 'selected workspace when that ID exists']) assert.ok(guide.includes(text), `Missing current Help topic: ${text}`);
  const integration = await source('docs/opencode-integration.md');
  assert.doesNotMatch(integration, /unreleased|OpenCode settings mean Off|native skill changes still require a new launch/i);
});

test('service health and workspace snapshot identify the current app version', async () => {
  const { version } = JSON.parse(await source('package.json'));
  assert.ok((await source('desktop/service/server.mjs')).includes(`service: 'mrmik', version: '${version}'`));
  assert.ok((await source('desktop/service/workspace-snapshot.mjs')).includes(`appVersion: '${version}'`));
});
