// Route table: [method, path pattern, handler]. A handler gets { params, query (URLSearchParams), body } and returns
// { status, body } (body undefined = no body).
import * as store from './store.mjs';

const ok = (body, status = 200) => ({ status, body });
const fail = (status, error) => ({ status, body: { error } });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const validTitle = (t) => typeof t === 'string' && t.trim() !== '';

export const routes = [
  ['GET', '/api/health', () => ok({ ok: true })],

  ['GET', '/api/tasks', () => ok({ items: store.list() })],

  ['POST', '/api/tasks', ({ body }) => {
    if (!isObject(body)) return fail(400, 'invalid_body');
    if (!validTitle(body.title)) return fail(400, 'invalid_title');
    if (body.done !== undefined && typeof body.done !== 'boolean') return fail(400, 'invalid_done');
    return ok(store.create({ title: body.title, done: body.done ?? false }), 201);
  }],

  ['GET', '/api/tasks/:id', ({ params }) => {
    const task = store.get(params.id);
    return task ? ok(task) : fail(404, 'not_found');
  }],
];
