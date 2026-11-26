// Actual installed Codex; synthetic configuration, no auth or inference.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
import { NativeProfileProbe } from '../codex-profile-probe.mjs';
import { codexBinary } from '../agents.mjs';

let probe;
try {
  const binary = codexBinary();
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-cli-initial-model-'));
  const home = path.join(root, 'codex'); await mkdir(home);
  await writeFile(path.join(home, 'config.toml'), 'model = "gpt-6-luna"\ncli_auth_credentials_store = "file"\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  Object.assign(env, { CODEX_HOME: home, HOME: root, USERPROFILE: root, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' });
  probe = new NativeProfileProbe(root, env, { binary });
  const config = await probe.config();
  assert.equal(config.model, 'gpt-6-luna');
  const at = performance.now();
  assert.equal(await probe.modelLabel(config), 'gpt-6-luna');
  console.log(JSON.stringify({ result: 'PASS native Codex initial configured model', additionalLabelReadMs: performance.now() - at, modelPrompts: 0 }));
  const defaultAt = performance.now(), label = await probe.modelLabel({});
  assert.ok(typeof label === 'string' && label.length > 0);
  console.log(JSON.stringify({ result: 'PASS native Codex catalog default', labelReadMs: performance.now() - defaultAt, modelPrompts: 0 }));
} finally {
  await probe?.close();
  await cleanupFixtures();
}
