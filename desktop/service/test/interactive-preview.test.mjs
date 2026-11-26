import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractivePreviews } from '../interactive-preview.mjs';
test('interactive HTML uses opaque-origin sandbox policy, no network/files, bounded memory and stable identities', async () => {
 const host = new InteractivePreviews(), origin = 'http://127.0.0.1:1234', preview = { kind: 'rich', blockKind: 'code', identity: 'slider', language: 'html', text: '<input type="range" oninput="document.title=this.value">' };
 const url = host.publish(preview, origin); assert.equal(host.publish(preview, origin), url); assert.equal(host.entries.size, 1);
 const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
 assert.equal(await host.serve({ method: 'GET' }, response, new URL(url), 'http://127.0.0.1:3456'), true); assert.equal(response.status, 200);
 assert.match(response.headers['Content-Security-Policy'], /sandbox allow-scripts;/); assert.doesNotMatch(response.headers['Content-Security-Policy'], /allow-same-origin/); assert.match(response.headers['Content-Security-Policy'], /connect-src 'none'/); assert.match(response.body, /oninput=/);
 assert.equal(host.publish({ ...preview, language: 'javascript' }, origin), undefined);
 for (let index = 0; index < 12; index++) host.publish({ ...preview, identity: `other-${index}` }, origin);
 assert.equal(host.entries.size, 12); await host.serve({ method: 'GET' }, response, new URL(url), 'http://127.0.0.1:3456'); assert.equal(response.status, 404);
 assert.equal(await host.serve({ method: 'GET' }, response, new URL(origin + '/view/file'), origin), false);
});
