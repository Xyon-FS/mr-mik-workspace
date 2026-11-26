import test from 'node:test';
import assert from 'node:assert/strict';
import { isFailedActivity, commandLabel } from '../../../src/desktop/graphicalActivityState.ts';
import { requestTitle } from '../../../src/desktop/requestPresentation.ts';

test('native decisions show the recorded outcome and describe only supported actions', () => {
  for (const status of ['declined','cancelled','canceled','interrupted','inProgress']) assert.equal(isFailedActivity({status,exitCode:130}),false);
  assert.equal(commandLabel({status:'declined',exitCode:1}),'Command declined');
  assert.equal(commandLabel({status:'cancelled',exitCode:130}),'Command cancelled');
  assert.equal(isFailedActivity({status:'failed',exitCode:0}),true);
  assert.equal(isFailedActivity({status:'completed',exitCode:1}),true);
  assert.equal(isFailedActivity({status:'completed',exitCode:0}),false);

  assert.equal(requestTitle('item/commandExecution/requestApproval',true),'Command approval');
  assert.equal(requestTitle('item/fileChange/requestApproval',true),'File changes approval');
  assert.equal(requestTitle('future/native/request',false),'Unsupported request');
  assert.equal(requestTitle('future/native/request',true),'Agent request');
});
