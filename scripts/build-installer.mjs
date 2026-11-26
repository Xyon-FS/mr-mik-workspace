import { access, mkdir, open, readFile, readdir, copyFile, writeFile, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeServiceExcludes } from './source-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src-tauri/target-isolated');
const cache = path.join(root, '.cache');
const lockPath = path.join(cache, 'manual-installer-build.lock');
const args = process.argv.slice(2);
const checkOnly = args.length === 1 && args[0] === '--check';
let lock;
try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 is required.');
  if (args.length && !checkOnly) throw new Error('Usage: Build-Installer.cmd [--check]');
  const nodeDir = path.dirname(process.execPath);
  const npmCli = path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js');
  const tauriCli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  for (const file of [npmCli, tauriCli, path.join(root, 'node_modules/typescript/bin/tsc')]) {
    await access(file).catch(() => { throw new Error(`Missing build dependency: ${file}. Use a full Node.js installation with npm and install the repository dependencies first.`); });
  }
  if (checkOnly) {
    console.log(`Build dependency paths are ready. No build was started.\nNode: ${process.execPath}\nOutput: ${path.join(root, 'release')}\nRust/MSVC and NSIS availability will be checked by Tauri during the build.`);
  } else {
    await mkdir(cache, { recursive: true });
    lock = await open(lockPath, 'wx').catch(error => {
      if (error.code === 'EEXIST') throw new Error(`An installer or portable build may be running. If a previous build was interrupted, verify it has stopped before removing ${lockPath}.`);
      throw error;
    });
    await lock.writeFile(`PID ${process.pid}\n`);
    const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const folder = path.join(root, 'release', `${version}-manual-${stamp}`);
    await mkdir(path.dirname(folder), { recursive: true });
    await mkdir(folder);
    const logPath = path.join(folder, 'build.log');
    const env = { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}`, CARGO_TARGET_DIR: target, npm_config_cache: path.join(cache, 'build-tooling/npm-cache') };
    console.log(`Building installer. This can take several minutes.\nLog: ${logPath}\nThe installer will not be launched.\n`);
    const log = createWriteStream(logPath, { flags: 'wx' });
    await new Promise((resolve, reject) => { log.once('open', resolve); log.once('error', reject); });
    let logError;
    log.on('error', error => { logError = error; });
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [tauriCli, 'build'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
        child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`Build failed (${code}). See ${logPath}`)));
      });
    } finally {
      log.end();
      await finished(log);
    }
    if (logError) throw logError;
    let verified = 0;
    async function parity(source, destination, skip = []) {
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (skip.includes(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new Error(`Unexpected link: ${entry.name}`);
        const a = path.join(source, entry.name), b = path.join(destination, entry.name);
        if (entry.isDirectory()) await parity(a, b, skip);
        else if (!(await readFile(a)).equals(await readFile(b))) throw new Error(`Bundled file differs: ${a}`);
        else verified++;
      }
    }
    const runtime = path.join(target, 'release/runtime');
    await parity(path.join(root, 'desktop/service'), path.join(runtime, 'service'), runtimeServiceExcludes);
    await parity(path.join(root, 'dist'), path.join(runtime, 'ui'));
    await access(path.join(runtime, 'service/node_modules/node-pty/prebuilds/win32-x64/pty.node'));
    const bundles = path.join(target, 'release/bundle/nsis');
    const installers = (await readdir(bundles)).filter(name => name.endsWith('.exe') && name.includes(`_${version}_`));
    if (installers.length !== 1) throw new Error('Expected exactly one installer for the current version.');
    const source = path.join(bundles, installers[0]);
    const name = `Mr-Mik_${version}-manual-${stamp}_windows-x64_setup.exe`;
    const output = path.join(folder, name);
    await copyFile(source, output, constants.COPYFILE_EXCL);
    async function digest(file) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      return hash.digest('hex');
    }
    const sha = await digest(output);
    if (sha !== await digest(source)) throw new Error('Installer copy checksum mismatch.');
    await writeFile(path.join(folder, 'SHA256SUMS.txt'), `${sha}  ${name}\n`);
    await writeFile(path.join(folder, 'BUILD.txt'), `Installer build succeeded.\nBundled source/UI files verified: ${verified}\nSHA256: ${sha}\nNo tests or model requests were run. Installer not launched.\n`);
    console.log(`\nSUCCESS\nInstaller: ${output}\nVerified files: ${verified}\nSHA256: ${sha}`);
  }
} catch (error) {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await unlink(lockPath).catch(error => { console.error(`Could not remove build lock: ${error.message}`); process.exitCode = 1; });
  }
}
