// Generic prompt loop for editing a JSON config from a schema. No imports on purpose: the schema entries, the validator and the
// loosening check are passed in, so the file can be copied into another skill. Zero dependencies.
//
// An entry: { path, group, type, values?, min?, max?, maxLen?, default, nullable, sensitive, what, why, readBy, factory?, alias?, children? }.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const get = (doc, p) => { let o = doc; for (const k of p.split('.')) { if (!isObj(o) || !(k in o)) return undefined; o = o[k]; } return o; };
function put(doc, p, v) {
  const out = clone(doc), ks = p.split('.');
  let o = out;
  for (const k of ks.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
  o[ks.at(-1)] = clone(v);
  return out;
}
function drop(doc, p) {
  const out = clone(doc), ks = p.split('.'), trail = [out];
  for (const k of ks.slice(0, -1)) { const n = trail.at(-1)?.[k]; if (!isObj(n)) return out; trail.push(n); }
  delete trail.at(-1)[ks.at(-1)];
  for (let i = trail.length - 1; i > 0; i--) if (Object.keys(trail[i]).length === 0) delete trail[i - 1][ks[i - 1]];
  return out;
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1):\d+(\/\S*)?$/;
const bad = (message) => ({ action: 'invalid', message });
const set = (value) => ({ action: 'set', value });
const portOf = (u) => /^http:\/\/[^/:]+:(\d+)/.exec(typeof u === 'string' ? u : '')?.[1];

// Pure: one typed line -> what to do. `current` is the value in the document (undefined when absent).
export function parseAnswer(e, text, current) {
  const t = String(text ?? '').trim();
  if (t === '') return { action: 'keep' };
  if (t === '?') return { action: 'help' };
  if (t === 's') return { action: 'skip-group' };
  if (t === 'q') return { action: 'quit' };
  if (t === '-') return e.nullable ? { action: 'unset' } : bad(`${e.path} cannot be unset`);
  const num = /^\d+$/.test(t) ? Number(t) : null;
  switch (e.type) {
    case 'enum': {
      if (num !== null && num >= 1 && num <= e.values.length) return set(e.values[num - 1].v);
      const hit = e.values.find((x) => x.v === t);
      return hit ? set(hit.v) : bad(`choose 1-${e.values.length}`);
    }
    case 'bool': {
      if (['1', 'true', 'y', 'yes'].includes(t)) return set(true);
      return ['2', 'false', 'n', 'no'].includes(t) ? set(false) : bad('choose 1 (true) or 2 (false)');
    }
    case 'int': {
      const n = /^-?\d+$/.test(t) ? Number(t) : NaN;
      return Number.isInteger(n) && n >= e.min && n <= e.max ? set(n) : bad(`must be an integer, ${e.min} to ${e.max}`);
    }
    case 'argv': case 'list': {
      if (t.startsWith('[')) {
        let v;
        try { v = JSON.parse(t); } catch (x) { return bad(`not a JSON array: ${x.message}`); }
        return Array.isArray(v) ? set(v) : bad('expected a JSON array');
      }
      const cur = Array.isArray(current) ? current : [];
      const m = /^([+-]) (.+)$/.exec(t);
      if (!m) return bad('use "+ item" to add, "- item" to remove, or a JSON array on one line');
      if (m[1] === '+') return set([...cur, m[2]]);
      return cur.includes(m[2]) ? set(cur.filter((x) => x !== m[2])) : bad(`"${m[2]}" is not in the list`);
    }
    case 'local_checks': {
      if (t === 'clear') return set([]);
      if (t.startsWith('[')) { try { const v = JSON.parse(t); return Array.isArray(v) ? set(v) : bad('expected a JSON array'); } catch (x) { return bad(`not a JSON array: ${x.message}`); } }
      return bad('Enter keeps, "clear" empties, or give a JSON array of { name, command, timeout_s } on one line');
    }
    case 'url': {
      if (num !== null) return num >= 1 && num <= 65535 ? set(`http://127.0.0.1:${num}`) : bad('port must be 1-65535');
      return LOCAL.test(t) ? set(t) : bad('give a port number, or http://localhost:<port> or http://127.0.0.1:<port>');
    }
    case 'ready': return num === 1 || num === 2 ? { action: 'choose', value: num === 1 ? 'url' : 'log_pattern' } : bad('choose 1 (url) or 2 (log_pattern)');
    case 'object-null': return t === 'y' ? set({}) : t === 'n' ? { action: 'keep' } : bad('answer y or n');
    default: {
      let v = t;
      if (t.startsWith('"')) { try { v = JSON.parse(t); } catch { return bad('not a valid JSON string'); } }
      return typeof v === 'string' && e.maxLen && v.length > e.maxLen ? bad(`at most ${e.maxLen} characters (got ${v.length})`) : set(v);
    }
  }
}

const shown = (v) => (v === undefined ? 'not set' : typeof v === 'string' ? v : JSON.stringify(v));
const HINT = { enum: (e) => `1-${e.values.length} choose`, bool: () => '1 true  2 false  choose', int: (e) => `${e.min}-${e.max}`, url: () => 'port number', ready: () => '1-2 choose', 'object-null': (e) => `Enable ${e.path} checks? y/n`, argv: () => '+ item  - item  or JSON array', list: () => '+ item  - item  or JSON array', local_checks: () => 'JSON array  clear' };

// The prompt text for one key (the typed line is read separately).
export function renderPrompt(e, current) {
  const head = `${e.path}   (current: ${shown(current)}, default: ${shown(e.default ?? undefined)})${e.sensitive ? '   SENSITIVE' : ''}`;
  const lines = [head, `  ${e.what}`];
  if (e.values) e.values.forEach((x, i) => lines.push(`    ${i + 1}) ${x.v}   ${x.d}`));
  if (e.type === 'ready') lines.push('    1) url   a local URL that answers', '    2) log_pattern   a line the app prints when it is up');
  const hints = ['Enter keep', HINT[e.type] ? `${HINT[e.type](e)}` : (e.maxLen ? `text, up to ${e.maxLen} characters` : 'type a value'), '? more'];
  if (e.nullable) hints.push('- unset');
  hints.push('s skip group', 'q quit without saving');
  lines.push(`  ${hints.join('   ')}`);
  return lines.join('\n');
}

const FACTORY_PULL = ['app.start', 'app.base_url', 'app.ready', 'readiness', 'readiness.min_level', 'local_checks'];

// Walk the entries (already in walk order) and return { doc, changed, quit }. Nothing is written here.
//   only: a key path or a group name; first: paths to visit before the rest; validateChange(before, after) -> { ok, errors };
//   loosens(entry, before, after) -> reason | null.
export async function walk({ entries, doc, io, validateChange, loosens, only, first = [] }) {
  const byPath = new Map(entries.map((x) => [x.path, x]));
  const exact = only && byPath.get(only) && byPath.get(only).type !== 'object-null';
  const scope = only ? entries.filter((x) => (exact ? x.path === only : x.group === only || x.path === only)) : entries;
  const queue = [...first.filter((p) => byPath.has(p)), ...scope.map((x) => x.path)];
  const objectNull = entries.filter((x) => x.type === 'object-null').map((x) => x.path);
  const done = new Set(), skipped = new Set(), pulled = new Set(), changed = [];
  let cur = clone(doc);
  const quit = () => ({ doc: cur, changed, quit: true });

  const ask = async (p) => { const a = await io.ask(p); return a === undefined || a === null ? 'q' : a; };
  const apply = async (e, next) => {
    if (e.path === 'autonomy.level') next = drop(next, 'merge.mode'); // one spelling of the setting only
    const v = validateChange(cur, next);
    if (!v.ok) { io.out(`  not accepted: ${v.errors.join('; ')}`); return false; }
    const reason = loosens(e, cur, next);
    if (reason) {
      io.out(`  SENSITIVE: this ${reason}.`);
      if (String(await ask('  Type yes to apply: ')).trim() !== 'yes') { io.out('  kept the old value'); return true; }
    }
    if (!same(get(cur, e.path), get(next, e.path)) && !changed.includes(e.path)) changed.push(e.path);
    if (e.path === 'verification.required' && get(next, e.path) === true && get(cur, e.path) !== true) {
      for (const p of [...FACTORY_PULL].reverse()) if (byPath.has(p) && !done.has(p)) { queue.unshift(p); pulled.add(p); }
    }
    cur = next;
    return true;
  };
  // app.ready: pick url or log_pattern, then its value, then timeout_s; the other key is dropped.
  const readyValue = async (kind, old) => {
    const port = portOf(get(cur, 'app.base_url'));
    const dflt = kind === 'url' && port ? `http://127.0.0.1:${port}` : undefined;
    const val = String(await ask(`  ${kind}${dflt ? ` [${dflt}]` : ''}: `)).trim() || dflt;
    if (!val) return null;
    const t = String(await ask(`  timeout_s [${old?.timeout_s ?? 120}]: `)).trim();
    return { [kind]: val, timeout_s: t === '' ? (old?.timeout_s ?? 120) : Number(t) };
  };

  while (queue.length) {
    const p = queue.shift();
    const e = byPath.get(p);
    if (!e || done.has(p) || e.alias || skipped.has(e.group)) continue;
    const parent = objectNull.find((o) => p.startsWith(`${o}.`));
    if (parent && get(cur, parent) === undefined) continue; // children exist only once the parent is present
    if (e.type === 'object-null' && get(cur, p) !== undefined) { done.add(p); continue; }
    done.add(p);
    if (pulled.has(p) && p === 'readiness.min_level' && get(cur, p) === undefined) { cur = put(cur, p, 4); changed.push(p); }
    for (;;) {
      io.out(renderPrompt(e, get(cur, p)));
      const r = parseAnswer(e, await ask('> '), get(cur, p));
      if (r.action === 'quit') return quit();
      if (r.action === 'keep') break;
      if (r.action === 'skip-group') { skipped.add(e.group); break; }
      if (r.action === 'help') { io.out([`  ${e.why}`, `  read by: ${e.readBy.join(', ')}`, ...(e.factory ? [`  factory run: ${e.factory}`] : [])].join('\n')); continue; }
      if (r.action === 'invalid') { io.out(`  ${r.message}`); continue; }
      let next;
      if (r.action === 'unset') next = drop(cur, p);
      else if (r.action === 'choose') {
        const v = await readyValue(r.value, get(cur, p));
        if (!v) { io.out('  a value is needed'); continue; }
        next = put(cur, p, v);
      } else next = put(cur, p, r.value);
      if (await apply(e, next)) break;
    }
  }
  return { doc: cur, changed, quit: false };
}
