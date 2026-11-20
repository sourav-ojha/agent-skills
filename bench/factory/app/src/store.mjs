// In-memory task store. Every app start begins empty, so a restart is a fresh seed.
const tasks = [];
let next = 1;

export function create(fields) {
  const task = { id: String(next++), ...fields };
  tasks.push(task);
  return task;
}

export const list = () => tasks.slice();

export const get = (id) => tasks.find((t) => t.id === id) ?? null;

export function update(id, fields) {
  const task = get(id);
  if (!task) return null;
  Object.assign(task, fields);
  return task;
}

export function remove(id) {
  const i = tasks.findIndex((t) => t.id === id);
  if (i === -1) return false;
  tasks.splice(i, 1);
  return true;
}

export function reset() {
  tasks.length = 0;
  next = 1;
}
