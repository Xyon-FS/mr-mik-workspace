import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionIssue } from '../connection-errors.mjs';
import { createObserver } from '../opencode/observer.mjs';
import { createV2Observer } from '../opencode/v2-observer.mjs';

test('connection categories distinguish evidence of offline, DNS failure, timeout, provider outage and account errors', () => {
  for (const [error, category] of [[{ code: 'ENETDOWN' }, 'offline'], [{ code: 'ENOTFOUND' }, 'remote-unreachable'], [{ code: 'ETIMEDOUT' }, 'timeout'], [{ httpStatus: 503 }, 'remote-unreachable'], [{ status: 401 }, 'authentication'], [{ status: 429 }, 'quota'], [{ message: 'Invalid MCP configuration' }, 'configuration'], [{ message: 'Unrecognised failure' }, 'unknown']]) assert.equal(connectionIssue(error).category, category);
  assert.equal(connectionIssue({ message: 'fetch failed' }, { localService: true }).category, 'local-service');
  assert.equal(connectionIssue({ navigatorOnline: false, code: 'ENOTFOUND' }).category, 'remote-unreachable');
  const issue = connectionIssue({ message: 'fetch failed https://secret:token@example.invalid?key=private', code: 'fixture-secret' });
  assert.ok(!JSON.stringify(issue).includes('private')); assert.ok(!JSON.stringify(issue).includes('fixture-secret'));
  assert.equal(issue.retry, 'connection-only');
});

test('OpenCode V1/V2 error observers keep only sanitized connection state and clear it on the next accepted turn', () => {
  const directory = process.cwd(), states = [];
  const observer = createObserver({ directory, nativeId: 'ses_owned', chatId: 'fixture', launchId: 'fixture', startedAt: 0, save: state => states.push(state) });
  observer({ type: 'session.error', properties: { sessionID: 'ses_owned', error: { name: 'APIError', data: { statusCode: 503, message: 'private-body-secret' } } } });
  assert.equal(states.at(-1).connectionIssue.category, 'remote-unreachable');
  assert.ok(!JSON.stringify(states).includes('private-body-secret'));
  observer({ type: 'session.status', properties: { sessionID: 'ses_owned', status: { type: 'busy' } } });
  assert.equal(states.at(-1).connectionIssue, null);
  const v2States = [], v2 = createV2Observer({ directory, nativeId: 'ses_owned', chatId: 'fixture', launchId: 'fixture', startedAt: 0, save: state => v2States.push(state) });
  v2({ type: 'session.execution.failed', created: 1, data: { sessionID: 'ses_owned', error: { data: { statusCode: 429 } } } });
  assert.equal(v2States.at(-1).connectionIssue.category, 'quota');
  v2({ type: 'session.execution.started', created: 2, data: { sessionID: 'ses_owned' } });
  assert.equal(v2States.at(-1).connectionIssue, null);
});
