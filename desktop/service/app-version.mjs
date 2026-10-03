import { readFile } from 'node:fs/promises';

// Packaged runtimes carry build metadata generated from the root package.json.
// Source checkouts read that same package directly; never use the service's
// independent package version or a user's Hub package.json.
export async function readAppVersion(bundled = new URL('./app-version.json', import.meta.url), source = new URL('../../package.json', import.meta.url)) {
  let text;
  try { text = await readFile(bundled, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; text = await readFile(source, 'utf8'); }
  const { version } = JSON.parse(text);
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid application version metadata.');
  return version;
}

export const appVersion = await readAppVersion();
