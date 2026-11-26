import test from 'node:test';
import assert from 'node:assert/strict';
import {fileCitations} from '../../../src/desktop/fileCitations.ts';
const render=text=>{const tree={type:'root',children:[{type:'paragraph',children:[{type:'text',value:text}]}]};fileCitations()(tree);return tree.children[0].children};
test('multiple native citations display filenames and preserve paths and surrounding prose', () => {
  const nodes = render(String.raw`Source: :codex-file-citation{path="C:\\Project\\città guide.pdf"} and ::codex-file-citation{path='/work/second.md' purpose="source"}`);
  assert.equal(nodes[0].value, 'Source: ');
  assert.equal(nodes[1].url, 'C:\\Project\\città guide.pdf');
  assert.equal(nodes[1].children[0].value, 'città guide.pdf');
  assert.equal(nodes[1].title, nodes[1].url);
  assert.equal(nodes[3].url, '/work/second.md');
});
test('code, links and invalid directives remain literal', () => {
 const text=':codex-file-citation{path="/work/source.pdf"}',tree={type:'root',children:[{type:'code',value:text},{type:'paragraph',children:[{type:'inlineCode',value:text},{type:'link',url:'https://example.com',children:[{type:'text',value:text}]}]}]};
 const before=structuredClone(tree);fileCitations()(tree);assert.deepEqual(tree,before);
 for(const text of [':codex-file-citation{path="javascript:alert(1)"}',':codex-file-citation{purpose="source"}',':codex-file-citation{path="/unfinished'])assert.equal(render(text)[0].type,'text');
});
