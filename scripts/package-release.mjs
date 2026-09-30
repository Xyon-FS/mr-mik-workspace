import { mkdir, copyFile, cp, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { starterFiles } from './source-files.mjs';
import { Projects } from '../desktop/service/projects.mjs';
import { addExampleWorkspace } from '../desktop/service/example-workspace.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Release packages require Windows x64.');
const require = createRequire(path.join(root, 'desktop/service/package.json'));
const { Zip, ZipDeflate } = require('fflate');
const output = path.join(root, 'release', version);
if (await lstat(output).catch(() => null)) throw new Error('Release folder already exists. Choose a new app version; no existing release is overwritten.');
const target = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(root, 'src-tauri/target');
const executable = path.join(target, 'release/mrmak-workspace.exe');
const runtime = path.join(root, '.cache/desktop-runtime');
await lstat(executable); await lstat(path.join(runtime, 'node.exe'));
const installers = (await readdir(path.join(target, 'release/bundle/nsis'))).filter(name => name.endsWith('.exe') && name.includes(version));
if (installers.length !== 1) throw new Error('Build exactly one matching NSIS installer before packaging.');
await mkdir(output, { recursive: true });
const portable = path.join(output, 'Mr-Mik-portable'); await mkdir(portable);
await copyFile(executable, path.join(portable, 'mrmak-workspace.exe'));
await cp(runtime, path.join(portable, 'runtime'), { recursive: true });
// Include maintained Hub skills/workflows without owner scopes or native settings.
for (const folder of ['scripts/video-watch', 'scripts/shared']) await cp(path.join(root, folder), path.join(portable, 'Hub', folder), { recursive: true, filter: source => !['__pycache__', 'node_modules'].includes(path.basename(source)) });
const skillNames = (await readdir(path.join(root, '.agents/skills'), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name);
for (const agent of ['.agents', '.claude']) {
  for (const name of skillNames) await cp(path.join(root, agent, 'skills', name), path.join(portable, 'Hub', agent, 'skills', name), { recursive: true, filter: source => !['__pycache__', 'node_modules'].includes(path.basename(source)) });
}
await mkdir(path.join(portable, 'Hub'), { recursive: true });
for (const [name, value] of Object.entries(starterFiles)) { const to = path.join(portable, 'Hub', name); await mkdir(path.dirname(to), { recursive: true }); await writeFile(to, JSON.stringify(value, null, 2) + '\n'); }
for (const folder of ['context', 'knowledge', 'processes', 'inbox', '.agents/skills', '.claude/skills']) await mkdir(path.join(portable, 'Hub', folder), { recursive: true });
for (const name of ['AGENTS.md', 'CLAUDE.md', 'processes/workspace-authoring.md', 'knowledge/video-watch.md', 'knowledge/voice-dictation.md']) { const file = path.join(portable, 'Hub', name); await mkdir(path.dirname(file), { recursive: true }); await copyFile(path.join(root, name), file); }
await cp(path.join(root, 'workspace/_shared'), path.join(portable, 'Hub/workspace/_shared'), { recursive: true });
await addExampleWorkspace(new Projects(path.join(portable, 'Hub'), path.join(portable, 'Hub/.mrmak')));
await writeFile(path.join(portable, 'Start Mr. Mik.cmd'), '@echo off\r\nstart "" "%~dp0mrmak-workspace.exe" --repo "%~dp0Hub"\r\n');
await writeFile(path.join(portable, 'README.txt'), 'Mr. Mik portable for Windows x64. Run Start Mr. Mik.cmd. A clean Hub is included. Install/sign in to Codex or Claude separately; CLI accounts and native transcripts remain in their normal profiles. App preferences remain under the Windows user profile. WebView2 must be installed. This portable folder is not a source repository.\n');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(path.join(root, name), path.join(portable, name));
const archive = path.join(output, `Mr-Mik_${version}_windows-x64_portable.zip`);
const stream = createWriteStream(archive, { flags: 'wx' });
let failure; stream.on('error', error => { failure = error });
const zip = new Zip((error, chunk, final) => { if (error) { failure = error; stream.destroy(error); return } stream.write(chunk); if (final) stream.end(); });
const visit = async (folder, relative = '') => {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Portable payload contains a link.');
    const name = relative + item.name;
    if (item.isDirectory()) await visit(path.join(folder, item.name), `${name}/`);
    else if (item.isFile()) {
      const entry = new ZipDeflate(`Mr-Mik/${name}`, { level: 6 }); zip.add(entry);
      for await (const chunk of createReadStream(path.join(folder, item.name), { highWaterMark: 65536 })) { if (failure) throw failure; entry.push(chunk) }
      entry.push(new Uint8Array(), true);
    }
  }
};
try { await visit(portable); zip.end(); await once(stream, 'finish'); if (failure) throw failure; } catch (error) { zip.terminate(); stream.destroy(); throw error; }
const installer = `Mr-Mik_${version}_windows-x64_setup.exe`;
await copyFile(path.join(target, 'release/bundle/nsis', installers[0]), path.join(output, installer));
const sums = [];
for (const name of [installer, path.basename(archive)]) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path.join(output, name))) hash.update(chunk); sums.push(`${hash.digest('hex')}  ${name}`); }
await writeFile(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(`Installer, portable ZIP and SHA256SUMS ready: ${output}. Nothing was published.`);
