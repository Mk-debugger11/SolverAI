import test from 'node:test';
import assert from 'node:assert/strict';
import { getAssignmentPageScope, assertAssignmentPageAction } from './assignmentPageScope.js';

const portal = 'https://my.newtonschool.co';

test('catalog URLs allow batch actions and reject the single assignment detector', () => {
  for (const path of ['/course/course-1/all_assignments', '/course/course-1/all_assignments/?page=2#assignments']) {
    const url = portal + path;
    assert.equal(getAssignmentPageScope(url).kind, 'catalog');
    assert.doesNotThrow(() => assertAssignmentPageAction(url, 'start'));
    assert.throws(() => assertAssignmentPageAction(url, 'inspect'), /assignment catalog/);
    assert.throws(() => assertAssignmentPageAction(url, 'solve'), /Solve unfinished assignments/);
  }
});

test('verified code and notebook workspaces allow single actions before inspection', () => {
  for (const path of ['/playground/code/problem-1', '/playground/newton-box/problem-2/?attempt=1']) {
    const url = portal + path;
    assert.equal(getAssignmentPageScope(url).kind, 'workspace');
    assert.doesNotThrow(() => assertAssignmentPageAction(url, 'inspect'));
    assert.doesNotThrow(() => assertAssignmentPageAction(url, 'solve'));
    assert.throws(() => assertAssignmentPageAction(url, 'start'), /All Assignments catalog/);
  }
});

test('unknown, unrelated and misleading URLs cannot start assignment work', () => {
  for (const url of [undefined, '', 'invalid', 'chrome://extensions', `${portal}/course/course-1`,
    'https://my.newtonschool.co.example.com/playground/code/p1',
    'https://example.com/course/course-1/all_assignments',
    'http://my.newtonschool.co/playground/code/p1',
    'https://my.newtonschool.co:8443/playground/code/p1',
    'https://user@my.newtonschool.co/playground/code/p1',
    'https://user:password@my.newtonschool.co/course/course-1/all_assignments',
    `${portal}/course/course-1/all_assignments/extra`, `${portal}/playground/code/p1/extra`]) {
    assert.ok(!['catalog', 'workspace'].includes(getAssignmentPageScope(url).kind));
    assert.throws(() => assertAssignmentPageAction(url, 'solve'));
    assert.throws(() => assertAssignmentPageAction(url, 'inspect'));
    assert.throws(() => assertAssignmentPageAction(url, 'start'));
  }
});
