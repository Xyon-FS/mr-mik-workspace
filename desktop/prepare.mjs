import { cp, mkdir, readFile, writeFile, access, realpath, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gameSkillPack } from './service/skill-pack.mjs';
import { buildStarterHub } from '../scripts/starter-hub.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(repo, '.cache', 'desktop-runtime');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This package currently targets Windows x64. Build on that platform.');
// Clear only this generated staging directory, after verifying its resolved path.
const actualRuntime = await realpath(runtime).catch(() => null);
if (actualRuntime) {
  const expected = path.join(await realpath(repo), '.cache', 'desktop-runtime');
  if (actualRuntime.toLowerCase() !== expected.toLowerCase()) throw new Error('Refusing to clear a staging directory outside this repository');
  await rm(actualRuntime, { recursive: true });
}
await mkdir(runtime, { recursive: true });
await buildStarterHub(repo, path.join(runtime, 'hub-template'));
const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const run = (args, cwd) => { const result = spawnSync(process.execPath, [npm, ...args], { cwd, stdio: 'inherit', windowsHide: true }); if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed`); };
run(['run', 'build'], repo);
await cp(process.execPath, path.join(runtime, 'node.exe'));
await mkdir(path.join(runtime, 'service'), { recursive: true });
const serviceSource = path.join(repo, 'desktop', 'service');
await cp(serviceSource, path.join(runtime, 'service'), { recursive: true, filter: source => !path.relative(serviceSource, source).split(path.sep).some(part => ['node_modules', 'test', '.cache'].includes(part)) });
// A checkout can itself live under a cache/worktree directory. Validate the
// payload before npm can resolve an unrelated parent package.json.
for (const file of ['package.json', 'package-lock.json', 'main.mjs', 'server.mjs']) await access(path.join(runtime, 'service', file));
for (const name of gameSkillPack) await cp(path.join(repo, '.agents/skills', name), path.join(runtime, 'service/skill-pack', name), { recursive: true });
await cp(path.join(repo, 'knowledge/voice-dictation.md'), path.join(runtime, 'service/skill-pack/voice-dictation.md'));
await cp(path.join(repo, 'processes/workspace-authoring.md'), path.join(runtime, 'service/skill-pack/workspace-authoring.md'));
await cp(path.join(repo, 'LICENSE'), path.join(runtime, 'service/skill-pack/LICENSE'));
await cp(path.join(repo, 'THIRD_PARTY_NOTICES.md'), path.join(runtime, 'service/skill-pack/NOTICE.md'));
run(['ci', '--omit=dev'], path.join(runtime, 'service'));
await cp(path.join(repo, 'dist'), path.join(runtime, 'ui'), { recursive: true });
// Vite deliberately does not copy the enormous workspace junction. Bundle only UI assets.
try { await access(path.join(repo, 'public', 'assets')); await cp(path.join(repo, 'public', 'assets'), path.join(runtime, 'ui', 'assets'), { recursive: true }); } catch { /* Optional brand assets. */ }
await writeFile(path.join(runtime, 'README.txt'), 'Mr. Mik local runtime. Node.js and native ConPTY bindings are bundled. User repositories, keys and CLI logins are not included.\n');
const nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
let license;
try { license = await readFile(nodeLicense); } catch {
  // Reuse an already bundled license only for the same Node version. This keeps
  // repeat desktop builds possible when the build machine is temporarily offline.
  for (const target of ['target', 'target-isolated']) {
    const previous = path.join(repo, 'src-tauri', target, 'release', 'runtime');
    const binary = path.join(previous, 'node.exe');
    const version = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (version.status === 0 && version.stdout.trim() === process.version) {
      license = await readFile(path.join(previous, 'NODE-LICENSE.txt')).catch(() => null);
      if (license) break;
    }
  }
  if (!license) {
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
    if (!response.ok) throw new Error('Could not retrieve the license for the bundled Node runtime');
    license = await response.text();
  }
}
await writeFile(path.join(runtime, 'NODE-LICENSE.txt'), license);
console.log('Desktop runtime prepared: Node, native terminals and production UI.');
