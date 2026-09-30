import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

async function component(relative) {
  const url = new URL(relative, import.meta.url);
  const source = await readFile(url, 'utf8');
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputText)(createRequire(url), module, module.exports);
  return module.exports;
}
test('report fallback preserves recovery controls and never renders raw error information', async () => {
  const { default: Boundary } = await component('../../../src/components/ReportBoundary.tsx');
  const boundary = new Boundary({ children: 'Normal report', onHome() {} });
  assert.equal(boundary.render(), 'Normal report');
  boundary.state = Boundary.getDerivedStateFromError(new Error('Sensitive fixture')); // Exercise fallback independently of a paid agent/UI session.
  const html = renderToStaticMarkup(boundary.render());
  assert.match(html, /Back to Workspace|Back to workspace/);
  assert.match(html, /Reload/);
  assert.doesNotMatch(html, /Sensitive fixture/);
});
test('Markdown base resolution works for relative service preview URLs', async () => {
  // Extract the real Markdown renderer without document editor hooks/imports.
  const file = new URL('../../../src/components/MarkdownDocument.tsx', import.meta.url);
  const source = await readFile(file, 'utf8');
  assert.match(source, /new URL\(baseUrl, window.location.href\)/);
  const base = new URL('/api/files/preview/report.md', 'http://127.0.0.1:3009/workspace').href;
  assert.equal(new URL('assets/image.png', base).href, 'http://127.0.0.1:3009/api/files/preview/assets/image.png');
  assert.equal(new URL('../notes.md', base).href, 'http://127.0.0.1:3009/api/files/notes.md');
});
