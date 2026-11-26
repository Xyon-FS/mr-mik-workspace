import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStructuredData } from '../../../src/desktop/parseStructuredData.ts';

test('structured data preserves quoted delimiters, escaped quotes and multiline fields', () => {
  assert.deepEqual(parseStructuredData('name,note\r\nAda,"a,b"\r\nLin,"line one\nline ""two"""\r\n', 'csv'), { kind: 'table', cells: [['name', 'note'], ['Ada', 'a,b'], ['Lin', 'line one\nline "two"']] });
  assert.deepEqual(parseStructuredData('name\tvalue\nAda\t42\n', 'tsv'), { kind: 'table', cells: [['name', 'value'], ['Ada', '42']] });
  assert.deepEqual(parseStructuredData('a,b\n"",', 'csv'), { kind: 'table', cells: [['a', 'b'], ['', '']] });
});
test('invalid or oversized data retains the source presentation instead of inventing rows', () => {
  for (const value of ['a,b\nx', 'a,b\n"unterminated,x', 'a,b\n"closed"junk,x', 'a,b\nx"bad,y', 'single\ncolumn']) assert.equal(parseStructuredData(value, 'csv'), null, value);
  assert.equal(parseStructuredData('x'.repeat(200001), 'json'), null);
  assert.equal(parseStructuredData(('a,b\n').repeat(1001), 'csv'), null);
  assert.equal(parseStructuredData(('a,'.repeat(100) + 'b\n').repeat(2), 'csv'), null);
  for (const value of ['{bad', 'null', '42', 'true', '"text"']) assert.equal(parseStructuredData(value, 'json'), null);
});
test('JSON objects and arrays remain data, including HTML strings and special property names', () => {
  const text = '{"__proto__":{"polluted":true},"html":"<script>bad()</script>","values":[null,false,0]}';
  const parsed = parseStructuredData(text, 'JSON');
  assert.deepEqual(parsed, { kind: 'json', value: JSON.parse(text) });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(parseStructuredData('[1,2]', 'json'), { kind: 'json', value: [1, 2] });
  assert.equal(parseStructuredData(text, 'javascript'), null);
});
