import { mkdir, copyFile, cp, readFile, readdir, writeFile, lstat, rename } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStarterHub } from './starter-hub.mjs';
import { portableLauncher } from './portable-layout.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Release packages require Windows x64.');
const require = createRequire(path.join(root, 'desktop/service/package.json'));
const { Zip, ZipDeflate } = require('fflate');
const suffix = process.env.MRMIK_RELEASE_SUFFIX || '';
if (suffix && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(suffix)) throw new Error('Invalid development release suffix.');
const label = suffix ? `${version}-${suffix}` : version;
const output = path.join(root, 'release', label);
if (await lstat(output).catch(() => null)) throw new Error('Release folder already exists. Choose a new app version; no existing release is overwritten.');
const target = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(root, 'src-tauri/target');
const executable = path.join(target, 'release/mrmak-workspace.exe');
const runtime = path.join(root, '.cache/desktop-runtime');
await lstat(executable); await lstat(path.join(runtime, 'node.exe'));
const installers = (await readdir(path.join(target, 'release/bundle/nsis'))).filter(name => name.endsWith('.exe') && name.includes(version));
if (installers.length !== 1) throw new Error('Build exactly one matching NSIS installer before packaging.');
await mkdir(output, { recursive: true });
const portable = path.join(output, 'Mr-Mik-portable'); await mkdir(portable);
const app = path.join(portable, 'App'); await mkdir(app);
await copyFile(executable, path.join(app, 'mrmak-workspace.exe'));
await cp(runtime, path.join(app, 'runtime'), { recursive: true });
await buildStarterHub(root, path.join(portable, 'Hub'));
await rename(path.join(portable, 'Hub'), path.join(portable, 'MyHub'));
await writeFile(path.join(portable, 'Start Mr. Mik.cmd'), portableLauncher);
await writeFile(path.join(portable, 'README.txt'), 'Mr. Mik portable for Windows x64. Run Start Mr. Mik.cmd. App contains the replaceable program; MyHub contains your data, including hidden folders. To update on the same PC, close the app and replace only App and the launcher: NEVER overwrite MyHub with the new example Hub. Older Hub folders remain supported. To use an external Hub, pass its folder as the first launcher argument. For another PC or a formatted system use full Hub export/import; native CLI auth/config and external projects are not included. Install/sign in to agents separately; native transcripts remain in the agent Windows profiles. Portable Hub selection/window preferences have a separate profile from the installer; portable launches never change the installed Hub selection. WebView2 must be installed.\n');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(path.join(root, name), path.join(portable, name));
const archive = path.join(output, `Mr-Mik_${label}_windows-x64_portable.zip`);
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
const installer = `Mr-Mik_${label}_windows-x64_setup.exe`;
await copyFile(path.join(target, 'release/bundle/nsis', installers[0]), path.join(output, installer));
const sums = [];
for (const name of [installer, path.basename(archive)]) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path.join(output, name))) hash.update(chunk); sums.push(`${hash.digest('hex')}  ${name}`); }
await writeFile(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(`Installer, portable ZIP and SHA256SUMS ready: ${output}. Nothing was published.`);
