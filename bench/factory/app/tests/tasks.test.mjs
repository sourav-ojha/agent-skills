// Unit tests of the base API handlers (run with `npm test` inside the app).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.mjs';
import { routes } from '../src/routes.mjs';

const call = (method, pattern, req = {}) => {
  const route = routes.find(([m, p]) => m === method && p === pattern);
  return route[2]({ params: {}, query: new URLSearchParams(), ...req });
};

test('creating a task returns 201 with an id and done false', () => {
  store.reset();
  const r = call('POST', '/api/tasks', { body: { title: 'Write report' } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { id: '1', title: 'Write report', done: false });
});

test('a missing or blank title is rejected with 400', () => {
  store.reset();
  assert.equal(call('POST', '/api/tasks', { body: {} }).status, 400);
  assert.equal(call('POST', '/api/tasks', { body: { title: '   ' } }).status, 400);
});

test('listing returns tasks in creation order', () => {
  store.reset();
  call('POST', '/api/tasks', { body: { title: 'a' } });
  call('POST', '/api/tasks', { body: { title: 'b' } });
  assert.deepEqual(call('GET', '/api/tasks').body.items.map((t) => t.title), ['a', 'b']);
});

test('an unknown task id is 404', () => {
  store.reset();
  assert.equal(call('GET', '/api/tasks/:id', { params: { id: '99' } }).status, 404);
});
