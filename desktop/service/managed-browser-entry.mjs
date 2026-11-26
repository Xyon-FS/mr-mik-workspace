// Runs inside the CLI's stdio MCP process. Playwright owns browser lifetime and
// closes it when the transport closes; every client uses an isolated context.
import { pathToFileURL } from 'node:url';
import { managedBrowserCli } from './managed-browser.mjs';

// Ambient Playwright MCP settings must not attach to a desktop/CDP endpoint,
// load authentication state or change the selected session/output settings.
for (const name of Object.keys(process.env)) if (name.startsWith('PLAYWRIGHT_MCP_')) delete process.env[name];
const cli = managedBrowserCli();
process.argv[1] = cli;
await import(pathToFileURL(cli).href);
