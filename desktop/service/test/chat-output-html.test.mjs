import test from 'node:test';
import assert from 'node:assert/strict';
import { standaloneHtml } from '../chat-html-output.mjs';
import { messageResults } from '../chat-results.mjs';

test('complete standalone HTML fragments are outputs without requiring Markdown fences', () => {
  const html = '<div style="color:white"><h1>Le idee migliori<br><span>iniziano così.</span></h1><p>Una scintilla.</p><div><a href="https://example.com">Esplora</a></div></div>';
  assert.equal(standaloneHtml(html), html);
  const result = messageResults({ id: 'answer', type: 'agentMessage', status: 'completed', text: html });
  assert.equal(result.length, 1); assert.equal(result[0].language, 'html'); assert.equal(result[0].text, html);
  for (const value of ['Here is <div>an example</div>', '<div>unfinished', '```html\n<div>Example</div>\n```', '&lt;div&gt;Example&lt;/div&gt;', '<div>example</div> followed by prose']) assert.equal(standaloneHtml(value), null);
  assert.deepEqual(messageResults({ id: 'stream', type: 'agentMessage', status: 'inProgress', text: html }), []);
});
