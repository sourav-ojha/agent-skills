// `deliver config <sub>`: the command logic, kept out of deliver.mjs. Returns an exit code; never calls process.exit.
import path from 'node:path';
import { CONFIG_PATH } from './config.mjs';
import { readDoc, getPath, setPath, unsetPath, validateChange, remainingErrors, effective, loosens, writeDoc, parseValue } from './configedit.mjs';
import { entry, keysOf, nearest, renderExplain, renderDocs, renderList } from './configschema.mjs';

function explain({ args, opt, io }) {
  const file = opt.local ? 'local' : 'project';
  if (opt.docs) { io.out(renderDocs(file)); return 0; }
  if (opt.list) { io.out(opt.json ? JSON.stringify(keysOf(file).map((k) => entry(k, file)), null, 2) : renderList(file)); return 0; }
  const key = args[0];
  if (!key) { io.err('explain needs a key, or --list or --docs'); return 1; }
  const e = entry(key, file);
  if (!e) {
    const near = nearest(key, file, 3);
    io.err(`unknown key "${key}"${near.length ? `; did you mean ${near.join(', ')}?` : ''}`);
    return 1;
  }
  io.out(opt.json ? JSON.stringify(e, null, 2) : renderExplain(e));
  return 0;
}

// Shared by set and unset: resolve the key, build the candidate, validate, guard loosening, write, re-parse.
async function change({ sub, args, opt, root, home, io, tty }) {
  const kind = opt.local ? 'local' : 'project';
  const key = args[0];
  if (!key || (sub === 'set' && args.length !== 2)) { io.err(sub === 'set' ? 'usage: config set <key> <json-value> [--local]' : 'usage: config unset <key> [--local]'); return 1; }
  const e = entry(key, kind);
  if (!e) {
    const near = nearest(key, kind, 3);
    io.err(`unknown key "${key}"${near.length ? `; did you mean ${near.join(', ')}?` : ''}`);
    return 1;
  }
  if (e.type === 'object') { io.err(`"${key}" is a group; set one of its keys`); return 1; }
  const file = opt.local ? path.join(home, 'config.json') : path.join(root, CONFIG_PATH);
  let cur;
  try { cur = readDoc(file); } catch (x) { io.err(x.message); return 1; }
  const { doc: before } = cur;
  if (!isPlain(before)) { io.err(`${file} must be a JSON object`); return 1; }
  let after, target = key;
  try {
    if (sub === 'set') {
      let value = parseValue(args[1]);
      if (e.alias) {
        if (!Object.hasOwn(e.alias.map, value)) { io.err(`${key} must be one of ${Object.keys(e.alias.map).join(', ')}`); return 1; }
        target = e.alias.to;
        value = e.alias.map[value];
        after = unsetPath(before, key);
      } else after = before;
      after = setPath(after, target, value);
    } else after = unsetPath(before, key);
  } catch (x) { io.err(x.message); return 1; }
  const oldV = getPath(before, target);
  const newV = getPath(after, target);
  if (JSON.stringify(after) === JSON.stringify(before) && (sub === 'unset' || JSON.stringify(oldV) === JSON.stringify(newV))) {
    io.out(JSON.stringify({ file, key, old: oldV ?? null, new: newV ?? null, changed: false, note: sub === 'unset' ? 'not set; nothing to do' : 'already that value', warnings: remainingErrors(before, after, kind) }));
    return 0;
  }
  const v = validateChange(before, after, kind);
  if (!v.ok) { io.err(`${key}: ${v.errors.join('; ')}`); return 1; }
  const reason = loosens(e, effective(before, kind), effective(after, kind));
  if (reason) {
    if (!tty) { io.err(`${key} ${reason}: a person must run "deliver config edit ${key}${opt.local ? ' --local' : ''}"`); return 1; }
    const ans = await io.ask(`${key} ${reason}. Type yes to apply: `);
    if (String(ans).trim() !== 'yes') { io.err('not applied'); return 1; }
  }
  try { writeDoc(file, after, { sha: cur.sha, mode: opt.local ? 0o600 : 0o644 }); } catch (x) { io.err(x.message); return 1; }
  let again;
  try { again = readDoc(file); } catch (x) { io.err(`wrote ${file} but could not read it back: ${x.message}`); return 1; }
  if (JSON.stringify(again.doc) !== JSON.stringify(after)) { io.err(`${file} changed during the write; check its contents`); return 1; }
  const re = validateChange(before, again.doc, kind);
  if (!re.ok) { io.err(`wrote ${file} but it now reports: ${re.errors.join('; ')}`); return 1; }
  io.out(JSON.stringify({ file, key: target, old: oldV ?? null, new: newV ?? null, changed: true, warnings: remainingErrors(before, again.doc, kind) }));
  return 0;
}
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function runConfigCommand({ sub, args = [], opt = {}, root, home, io, tty }) {
  if (sub === 'explain') return explain({ args, opt, io });
  if (sub === 'set' || sub === 'unset') return change({ sub, args, opt, root, home, io, tty });
  io.err(`config ${sub}: not implemented yet`);
  return 1;
}
