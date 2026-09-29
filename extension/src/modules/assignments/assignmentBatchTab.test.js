import test from 'node:test';
import assert from 'node:assert/strict';
import { openCourseAssignmentCatalog } from './assignmentBatchTab.js';

const overview = 'https://my.newtonschool.co/course/course-1/details?from=home';

test('course overview opens its catalog in a background tab', async () => {
  const created = [];
  const tabs = {
    async create(options) { created.push(options); return { id: 11 }; },
    async get(id) { return { id, status: 'complete', url: created[0].url }; },
  };
  assert.equal(await openCourseAssignmentCatalog(overview, 7, null, tabs), 11);
  assert.deepEqual(created, [{ url: 'https://my.newtonschool.co/course/course-1/all_assignments', active: false, openerTabId: 7 }]);
});

test('course overview reuses a saved catalog even when it has a page query', async () => {
  const tabs = {
    async get(id) { return { id, url: 'https://my.newtonschool.co/course/course-1/all_assignments?page=2' }; },
    async create() { throw new Error('A new tab was unnecessary.'); },
  };
  assert.equal(await openCourseAssignmentCatalog(overview, 7, 12, tabs), 12);
});

test('a closed catalog is replaced for batch recovery', async () => {
  const created = [];
  const tabs = {
    async get(id) {
      if (id === 12) throw new Error('No tab with id: 12');
      return { id, status: 'complete' };
    },
    async create(options) { created.push(options); return { id: 13 }; },
  };
  assert.equal(await openCourseAssignmentCatalog(overview, 7, 12, tabs), 13);
  assert.equal(created[0].url, 'https://my.newtonschool.co/course/course-1/all_assignments');
});
