import { access, mkdir, open, readFile, readdir, copyFile, writeFile, unlink } from 'node:fs/promises';
import { createWriteStream, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeServiceExcludes } from './source-files.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runLogged(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { process.stdout.write(data); options.log.write(data); });
    child.stderr.on('data', data => { process.stderr.write(data); options.log.write(data); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Command failed (${code}): ${args.join(' ')}`)));
  });
}

async function parity(source, destination, skip = []) {
  let verified = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected link in build input: ${entry.name}`);
    const a = path.join(source, entry.name), b = path.join(destination, entry.name);
    if (entry.isDirectory()) verified += await parity(a, b, skip);
    else if (!(await readFile(a)).equals(await readFile(b))) throw new Error(`Portable contains a stale file: ${a}`);
    else verified++;
  }
  return verified;
}

export async function buildPortable({ root = repositoryRoot, node = process.execPath, checkOnly = false, run = runLogged, info = console.log } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 is required.');
  const nodeDir = path.dirname(node), target = path.join(root, 'src-tauri/target-isolated');
  const cache = path.join(root, '.cache'), tauri = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  for (const file of [path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), tauri, path.join(root, 'node_modules/typescript/bin/tsc')]) {
    await access(file).catch(() => { throw new Error(`Missing build dependency: ${file}. Install the repository dependencies and use a full Node.js installation with npm.`); });
  }
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid application version.');
  if (checkOnly) {
    info(`Portable build dependencies are ready. No build was started.\nNode: ${node}\nOutput: ${path.join(root, 'release')}\nRust/MSVC will be checked by Tauri during compilation. NSIS is not needed.`);
    return { checked: true };
  }
  await mkdir(cache, { recursive: true });
  // The installer uses this lock too: both builds share the staging runtime and target.
  const lockPath = path.join(cache, 'manual-installer-build.lock');
  const lock = await open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error(`An installer or portable build may already be running. Lock: ${lockPath}. If a previous build was interrupted, confirm it has stopped before removing the lock.`);
    throw error;
  });
  let log, logError, logPath, folder, result;
  try {
    await lock.writeFile(`PID ${process.pid}\nPortable build\n`);
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').toLowerCase();
    const suffix = `portable-${stamp}-${randomBytes(3).toString('hex')}`;
    folder = path.join(root, 'release', `${version}-${suffix}`);
    const logDir = path.join(cache, 'build-logs');await mkdir(logDir, { recursive: true });
    logPath = path.join(logDir, `${suffix}.log`);
    log = createWriteStream(logPath, { flags: 'wx' });
    // Keep disk errors observable even if a child is still producing output.
    log.on('error', error => { logError = error; });
    const env = { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}`, CARGO_TARGET_DIR: target, MRMIK_RELEASE_SUFFIX: suffix, npm_config_cache: path.join(cache, 'build-tooling/npm-cache') };
    const options = { cwd: root, env, log };
    info(`Building portable. This can take several minutes.\nLog: ${logPath}\nThe application will not be launched or installed.\n`);
    const step = text => { info(text);log.write(text + '\n'); };
    step('[1/3] Building the current application and runtime...');
    await run(node, [tauri, 'build', '--no-bundle'], options);
    step('[2/3] Creating a new portable folder and ZIP...');
    await run(node, [path.join(root, 'scripts/package-release.mjs'), '--portable-only'], options);
    const portable = path.join(folder, 'Mr-Mik-portable'), runtime = path.join(portable, 'App/runtime');
    const verified = await parity(path.join(root, 'desktop/service'), path.join(runtime, 'service'), runtimeServiceExcludes) + await parity(path.join(root, 'dist'), path.join(runtime, 'ui'));
    if (!(await readFile(path.join(target, 'release/mrmak-workspace.exe'))).equals(await readFile(path.join(portable, 'App/mrmak-workspace.exe')))) throw new Error('Portable native host differs from the completed build.');
    step('[3/3] Checking checksums, clean Hub and bundled terminal runtime...');
    await run(node, [path.join(root, 'scripts/verify-release.mjs')], options);
    const archive = path.join(folder, `Mr-Mik_${version}-${suffix}_windows-x64_portable.zip`);
    await access(archive);
    await writeFile(path.join(folder, 'BUILD.txt'), `Portable build and verification succeeded.\nSource/UI files matched: ${verified}\nArchive: ${path.basename(archive)}\nChecksums: SHA256SUMS.txt\nUser Hubs and installed applications were not modified. No model calls or application launches.\n`);
    result = { archive, folder, portable, verified, log: path.join(folder, 'build.log') };
  } catch (error) {
    throw new Error(`${error.message}${logPath ? `\nBuild log: ${logPath}` : ''}${folder ? `\nIncomplete output, if present: ${folder}` : ''}`, { cause: error });
  } finally {
    try { if (log) { log.end();await finished(log); } }
    finally {
      await lock.close();
      await unlink(lockPath).catch(error => { throw new Error(`Could not remove build lock ${lockPath}: ${error.message}`); });
    }
  }
  if (logError) throw logError;
  await copyFile(logPath, result.log, constants.COPYFILE_EXCL);
  info(`\nSUCCESS\nPortable ZIP: ${result.archive}\nReady-to-run folder: ${result.portable}\nBuild log: ${result.log}\n\nKeep your existing MyHub when updating. Replace only App and the launcher.`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length && !(args.length === 1 && args[0] === '--check')) throw new Error('Usage: Build-Portable.cmd [--check]');
    await buildPortable({ checkOnly: args.includes('--check') });
  } catch (error) { console.error(`\nERROR: ${error.message}`);process.exitCode = 1; }
}
