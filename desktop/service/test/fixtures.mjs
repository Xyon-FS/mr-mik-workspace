import { mkdtemp as nativeMkdtemp, lstat, realpath, rm } from 'node:fs/promises';
import { lstatSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

// Only directories returned by this process's mkdtemp are eligible for removal.
// Never sweep Temp/.cache, and never follow a replaced root or junction target.
const directories = new Map();
const services = new Set();

// Chromium needs the actual OS known-folder environment even when service tests
// isolate HOME/LOCALAPPDATA. Playwright still supplies its own temporary profile.
export function testBrowserEnvironment() {
  const env = { ...process.env };
  for (const key of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME']) if (process.env[`MRMIK_BROWSER_${key}`]) env[key] = process.env[`MRMIK_BROWSER_${key}`];
  return env;
}

export async function mkdtemp(prefix, options) {
  const folder = await nativeMkdtemp(prefix, options);
  const resolved = await realpath(folder);
  const info = await lstat(folder);
  directories.set(path.resolve(folder.toString()), { resolved, ino: info.ino });
  return folder;
}

function validate(folder, expected, info, resolved) {
  if (!info.isDirectory() || info.isSymbolicLink() || resolved !== expected.resolved || info.ino !== expected.ino) {
    throw new Error(`Refusing to clean a replaced test fixture: ${folder}`);
  }
}

export async function cleanupFixtures() {
  const errors = [];
  for (const service of services) {
    try { await service.close(); services.delete(service); } catch (error) { errors.push(error); }
  }
  // If a service cannot close, retain its files rather than racing a live writer.
  if (!errors.length) for (const [folder, expected] of directories) {
    try {
      const info = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info) {
        validate(folder, expected, info, await realpath(folder));
        // Node removes contained symlinks/junctions themselves, not their targets.
        await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      directories.delete(folder);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Test fixture cleanup failed; retained paths require review.');
}

export async function createService(options, factory) {
  const nativeCreateService = factory || (await import('../server.mjs')).createService;
  // An omitted profile root must never fall back to the user's account registry.
  const profileRoot = options.profileOptions?.root || await mkdtemp(path.join((await import('node:os')).tmpdir(), 'mik-test-accounts-'));
  // General service/UI fixtures must not query the real native Claude login.
  // Actual CLI acceptance opts into explicit isolated credentials separately.
  const service = await nativeCreateService({ ...options, profileOptions: { claudeIdentity: async () => ({ status: 'logged-out', identity: null }), ...options.profileOptions, root: profileRoot } });
  services.add(service);
  const close = service.close.bind(service);
  service.close = async (...closeArgs) => {
    await close(...closeArgs);
    services.delete(service);
  };
  return service;
}

if (process.argv.some(arg => arg.endsWith('.test.mjs'))) {
  const { after } = await import('node:test');
  after(cleanupFixtures);
} else process.once('beforeExit', () => {
  cleanupFixtures().catch(error => { console.error(error); process.exitCode = 1; });
});

// Best effort for explicit process.exit()/uncaught script failures, where async
// teardown cannot run. Report failures instead of hiding abandoned fixtures.
process.once('exit', () => {
  if (services.size) {
    console.error('Test services did not complete teardown; their fixtures are retained for review.');
    process.exitCode = 1;
    return;
  }
  for (const [folder, expected] of directories) {
    try {
      let info;
      try { info = lstatSync(folder); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      validate(folder, expected, info, realpathSync.native(folder));
      rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) { console.error(`Fixture cleanup failed: ${folder}: ${error.message}`); process.exitCode = 1; }
  }
});
