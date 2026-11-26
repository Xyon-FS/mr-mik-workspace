import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {writeFile,stat,mkdir} from 'node:fs/promises';
import {mkdtemp} from './fixtures.mjs';
import {recordedQuoteSuffix, visibleUserText} from '../chat-input-presentation.mjs';
import {projectChatItem} from '../codex-chat-items.mjs';
import {attachmentPreview} from '../chat-attachment-preview.mjs';
test('only verified native attachment suffixes are hidden, without rewriting native text',()=>{
 const local='C:/fixture/note.txt', item={text:'Inspect this.\n\nAttached paths:\n'+JSON.stringify(local),attachments:[{path:local}]};
 assert.equal(visibleUserText(item),'Inspect this.');assert.ok(item.text.includes('Attached paths:'));
 assert.equal(visibleUserText({...item,attachments:[{path:'C:/other.txt'}]}),item.text);
 assert.equal(visibleUserText({...item,text:'Explain Attached paths:\nnot transport'}),'Explain Attached paths:\nnot transport');
 assert.equal(visibleUserText({...item,text:item.text+'\nExtra user prose'}),item.text+'\nExtra user prose');
});
test('preview is bounded and distinguishes current text, folders, unsupported binaries and large files',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mik-attachment-preview-'));
 const text=path.join(root,'sample.html');await writeFile(text,'<script>window.test=1</script>');let info=await stat(text);
 const preview=await attachmentPreview(text,info,{mtimeMs:info.mtimeMs-1,size:info.size});assert.equal(preview.kind,'text');assert.equal(preview.url,undefined);assert.match(preview.message,/changed/);
 await writeFile(text,'x'.repeat(210000));info=await stat(text);const bounded=await attachmentPreview(text,info);assert.equal(bounded.text.length,200000);assert.equal(bounded.truncated,true);
 const folder=path.join(root,'folder');await mkdir(folder);assert.equal((await attachmentPreview(folder,await stat(folder))).kind,'folder');
 const huge=await attachmentPreview(path.join(root,'large.pdf'),{size:11000000,mtime:new Date(),mtimeMs:1,isDirectory:()=>false,isFile:()=>true});assert.match(huge.message,/10 MB/);assert.equal(huge.url,undefined);
});

test('Codex native echo restores citations beside skills and attachments', () => {
 const file = path.resolve('reference.txt');
 const quotes = [
  { type: 'quote', role: 'assistant', itemId: 'source', text: 'First line\n\nLast line' },
  { type: 'quote', role: 'user', itemId: 'question', text: 'Original question' },
 ];
 const suffix = recordedQuoteSuffix(quotes);
 const text = 'Review.' + suffix + '\n\nAttached paths:\n' + JSON.stringify(file);
 const native = { id: 'input', type: 'userMessage', content: [
  { type: 'text', text },
  { type: 'skill', name: 'fixture', path: path.resolve('SKILL.md') },
 ] };
 const projected = projectChatItem(native);
 assert.equal(projected.text, text);
 assert.equal(projected.attachments[0].path, file);
 assert.equal(visibleUserText(projected), 'Review.');
 const withoutQuotes = { ...projected, attachments: [], composerContext: [] };
 assert.equal(visibleUserText(withoutQuotes), text);
 const mismatched = [{ ...quotes[0], text: 'Different quoted text' }, quotes[1]];
 assert.equal(visibleUserText({ ...projected, composerContext: mismatched }), 'Review.' + suffix);
 assert.deepEqual(projected.composerContext.filter(item => item.type === 'quote').map(({ id, ...quote }) => quote), quotes);
 assert.equal(projected.composerContext[0].name, 'fixture');
 const malformed = { ...native, content: [{ type: 'text', text: 'Review.' + suffix + '\nUnquoted line' }] };
 assert.equal(projectChatItem(malformed).composerContext, undefined);
});
