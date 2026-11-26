// Real native browser with localhost fixtures. No OAuth, CDP or real login.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { openPrivateLoginBrowser } from '../codex-private-login.mjs';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-private-native-acceptance-'));
const resources = [], reports = []; let observed;
const server = http.createServer(async (request, response) => {
  if (request.url === '/report') {
    let input = ''; for await (const chunk of request) input += chunk;
    reports.push(JSON.parse(input)); response.end('ok'); observed?.(); return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(`<title>Synthetic private login check</title><script>
    const data={cookies:document.cookie,storage:localStorage.getItem('synthetic')};
    document.cookie='synthetic=temporary; SameSite=Lax';localStorage.setItem('synthetic','temporary');
    fetch('/report',{method:'POST',body:JSON.stringify(data)});
  </script>`);
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (let i = 0; i < 2; i++) {
    console.log(`Native private browser fixture ${i + 1}: starting`);
    const pageUrl = `http://127.0.0.1:${server.address().port}/fixture`;
    let timer;
    const report = new Promise((resolve, reject) => { observed = resolve; timer = setTimeout(() => reject(new Error('Synthetic native browser did not report')), 20000); });
    report.catch(() => {});
    try {
      const browser = await openPrivateLoginBrowser('https://auth.openai.com/oauth/authorize?state=synthetic', { temporaryRoot: base,
        spawnProcess: (file, args, options) => {
          assert.ok(!args.some(arg => /remote-debugging|enable-automation|headless/.test(arg)));
          // Headless and background-network restrictions are test-only. The
          // production launcher never alters requests or uses automation flags.
          return spawn(file, [...args.slice(0, -1), '--headless=new', '--disable-background-networking', pageUrl], options);
        } });
      resources.push(browser); console.log('Native private browser started'); await report; console.log('Local fixture report received'); await browser.close(); console.log('Native private browser closed');
      assert.deepEqual(await readdir(base), []);
    } finally { clearTimeout(timer); observed = null; }
  }
  assert.deepEqual(reports, [{ cookies: '', storage: null }, { cookies: '', storage: null }]);
  console.log('PASS native private browser: isolated cookie/storage sessions, temporary profile removal, no production automation/CDP flags; localhost only, no OAuth or credentials.');
} finally {
  await Promise.all(resources.map(browser => browser.close()));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await cleanupFixtures();
}
