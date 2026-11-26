import test from 'node:test';
import assert from 'node:assert/strict';
import {skillCompletion,completeSkill} from '../skill-completion.mjs';
test('editing a skill replaces its complete token while retaining surrounding prose',()=>{
 const text='Use $workspace-authoring here',token=skillCompletion(text,10);assert.deepEqual(token,{start:4,end:24,query:'works'});
 assert.equal(completeSkill(text,token,'plan').text,'Use $plan here');assert.equal(completeSkill(text,token,'plan').cursor,9);
 assert.deepEqual(skillCompletion('$',1),{start:0,end:1,query:''});assert.equal(completeSkill('$',skillCompletion('$',1),'plan').text,'$plan ');
 assert.equal(skillCompletion('$plan',2,4),null);
});
test('suggestions respect native code, escape, math, path and identifier exclusions',()=>{
 for(const text of ['\\$','identifier$','folder/$','`$plan`','```text\n$plan\n```','```\n$','$$x$$','$x + y$']){
  const cursor=text.indexOf('$')+1;assert.equal(skillCompletion(text,cursor),null,text);
 }
 assert.ok(skillCompletion('Please use $review',18));
 const text='$plan after';assert.throws(()=>completeSkill(text,skillCompletion(text,5),'workspace-authoring',12),/Shorten/);
});
