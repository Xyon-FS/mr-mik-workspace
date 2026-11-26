import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

export const browserServerName = 'mr_mik_playwright';
export const browserChoices = ['off', 'msedge', 'chrome'];
const require = createRequire(import.meta.url);

export function browserChoice(settings, projectId) {
  const override = projectId && settings.managedBrowserProjects?.[projectId];
  return browserChoices.includes(override) ? override : settings.managedBrowser || 'off';
}

export function managedBrowserDefinition(choice, { outputDir, headless = false } = {}) {
  if (!browserChoices.includes(choice)) throw new Error('Choose Off, Edge or Chrome for the Mr. Mik browser.');
  if (choice === 'off') return null;
  if (!outputDir || !path.isAbsolute(outputDir)) throw new Error('A local browser output folder is required.');
  // Native configs merge fields under matching names. A fresh invocation-only
  // name avoids overwriting/inheriting a user's unrelated server definition.
  return { serverName: `${browserServerName}_${randomBytes(6).toString('hex')}`, command: process.execPath, args: [fileURLToPath(new URL('./managed-browser-entry.mjs', import.meta.url)),
    '--browser', choice, '--isolated', '--output-dir', outputDir, '--file-paths', 'absolute', ...(headless ? ['--headless'] : [])] };
}

export function managedBrowserCli() {
  // Resolve only the pinned service dependency; never use npx or a desktop host.
  try { return path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'); }
  catch { throw new Error('The Mr. Mik browser runtime is missing. Prepare or update the app runtime before enabling browser tools.'); }
}

export const browserOrientation = 'Mr. Mik provides mr_mik_playwright_<session suffix> browser tools in this chat. The unique server name avoids conflicts with existing MCP definitions. Use its exposed tools for HTTP card previews and websites. Reuse recent observations while valid; prefer browser_find for targeted lookups and browser_fill_form for multiple fields. Avoid duplicate snapshots; refresh observations after navigation, manual control or stale references. Snapshot and screenshot results may be absolute file paths; read or view those files using native tools and respect permission refusals. This is a temporary browser session, separate from personal browser tabs and logins. Browser state is lost when its MCP session closes. Native tool approvals still apply. Never attach to a personal browser or install another browser automatically.';
