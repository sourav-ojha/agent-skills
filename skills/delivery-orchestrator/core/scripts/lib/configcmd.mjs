// `deliver config <sub>`: the command logic, kept out of deliver.mjs. Returns an exit code; never calls process.exit.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH } from './config.mjs';
import { readDoc, getPath, setPath, unsetPath, validateChange, remainingErrors, effective, loosens, writeDoc, parseValue, diffLines } from './configedit.mjs';
import { SCHEMA, GROUPS, entry, keysOf, nearest, renderExplain, renderDocs, renderList } from './configschema.mjs';
import { walk } from './wizard.mjs';

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

// Draft file for `init --from-draft`: a regular JSON file under 64 KiB, never a symlink.
function readDraft(f) {
  let fd;
  try { fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (x) {
    throw new Error(x.code === 'ELOOP' ? `draft ${f} is a symlink; refusing to use it` : `cannot read draft ${f}: ${x.message}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`draft ${f} is not a regular file`);
    if (st.size > 65536) throw new Error(`draft ${f} is over 64 KiB`);
    let d;
    try { d = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch (x) { throw new Error(`draft ${f} is not valid JSON: ${x.message}`); }
    if (!isPlain(d)) throw new Error(`draft ${f} must be a JSON object`);
    return d;
  } finally { fs.closeSync(fd); }
}

// Keys named by parser errors ("key: message"), mapped to the nearest schema key at or above them.
const failingKeys = (errors, kind) => [...new Set(errors.map((m) => {
  const k = m.split(':')[0];
  return keysOf(kind).filter((p) => k === p || k.startsWith(`${p}.`)).sort((a, b) => b.length - a.length)[0];
}).filter(Boolean))];

// init and edit: walk the keys, show the diff, ask once, write.
async function wizard({ sub, args, opt, root, home, io, tty }) {
  const kind = opt.local ? 'local' : 'project';
  if (!tty) { io.err(`config ${sub} needs a terminal; from a script use "deliver config set <key> <json-value>"`); return 1; }
  if (opt.profile === 'factory') { io.err('--profile factory: not implemented yet'); return 1; }
  if (opt.profile !== undefined && opt.profile !== 'basic') { io.err(`unknown profile "${opt.profile}" (basic)`); return 1; }
  const file = opt.local ? path.join(home, 'config.json') : path.join(root, CONFIG_PATH);
  let cur, start;
  try { cur = readDoc(file); } catch (x) { io.err(x.message); return 1; }
  if (!isPlain(cur.doc)) { io.err(`${file} must be a JSON object`); return 1; }
  if (sub === 'init') {
    if (cur.exists) { io.err(`${file} already exists; use "deliver config edit"`); return 1; }
    try { start = opt['from-draft'] ? readDraft(opt['from-draft']) : {}; } catch (x) { io.err(x.message); return 1; }
  } else {
    if (!cur.exists) { io.err(`${file} does not exist; use "deliver config init"`); return 1; }
    start = cur.doc;
  }
  const only = args[0];
  if (only && !keysOf(kind).includes(only) && !GROUPS.includes(only)) {
    const near = nearest(only, kind, 3);
    io.err(`unknown key or group "${only}"${near.length ? `; did you mean ${near.join(', ')}?` : ''}`);
    return 1;
  }
  const empty = {};
  const problems = validateChange(empty, start, kind).errors;
  const unknown = problems.filter((m) => m.startsWith('config:'));
  if (sub === 'init' && unknown.length) { io.err(`draft not used: ${unknown.join('; ')}`); return 1; }
  if (problems.length) io.out(`${file} has problems:\n${problems.map((m) => `  ${m}`).join('\n')}`);
  const entries = GROUPS.flatMap((g) => SCHEMA.filter((x) => x.file === kind && x.group === g));
  const r = await walk({
    entries, doc: start, io, only, first: only ? [] : failingKeys(problems, kind),
    validateChange: (b, a) => validateChange(b, a, kind),
    loosens: (e, b, a) => loosens(e, effective(b, kind), effective(a, kind)),
  });
  const closedMsg = () => { io.err('input closed; nothing written'); return 1; };
  if (r.quit) { if (r.closed) return closedMsg(); io.out('nothing written'); return 0; }
  const base = sub === 'init' ? empty : cur.doc;
  if (JSON.stringify(r.doc) === JSON.stringify(base)) { io.out('no changes; nothing written'); return 0; }
  const v = validateChange(base, r.doc, kind);
  if (!v.ok) { io.err(`not written: ${v.errors.join('; ')}`); return 1; }
  // Every sensitive loosening between the file as it is on disk (empty for init) and the result needs a typed yes,
  // including values that came in from a draft or were already in the file before this walk touched them.
  const risky = [], seen = new Set();
  // Alias spellings go last, so the real key is the one named.
  for (const e of entries.filter((x) => x.sensitive).sort((p, q) => !!p.alias - !!q.alias)) {
    const reason = loosens(e, effective(base, kind), effective(r.doc, kind));
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    risky.push({ key: e.path, reason, done: r.confirmed.includes(e.path) || (e.alias && r.confirmed.includes(e.alias.to)) });
  }
  io.out(sub === 'init' ? JSON.stringify(r.doc, null, 2).split('\n').map((l) => `+ ${l}`).join('\n') : diffLines(base, r.doc).join('\n'));
  if (risky.length) io.out(`sensitive changes: ${risky.map((x) => x.key).join(', ')}`);
  for (const x of risky.filter((y) => !y.done)) {
    const a = await io.ask(`${x.key} ${x.reason}. Type yes to apply: `);
    if (a === null || a === undefined) return closedMsg();
    if (String(a).trim() !== 'yes') { io.err(`not written: ${x.key} was not confirmed`); return 1; }
  }
  const yAns = await io.ask(`Write ${file}? (y/n) `);
  if (yAns === null || yAns === undefined) return closedMsg();
  const yn = String(yAns).trim().toLowerCase();
  if (yn !== 'y' && yn !== 'yes') { io.out('nothing written'); return 0; }
  try { writeDoc(file, r.doc, { sha: cur.sha, mode: opt.local ? 0o600 : 0o644 }); } catch (x) { io.err(x.message); return 1; }
  io.out(`wrote ${file}`);
  io.out(opt.local ? 'next: nothing to commit; the next factory run reads this file' : `next: commit ${CONFIG_PATH} and merge it to the base branch`);
  return 0;
}

export async function runConfigCommand({ sub, args = [], opt = {}, root, home, io, tty }) {
  if (sub === 'explain') return explain({ args, opt, io });
  if (sub === 'set' || sub === 'unset') return change({ sub, args, opt, root, home, io, tty });
  if (sub === 'init' || sub === 'edit') return wizard({ sub, args, opt, root, home, io, tty });
  io.err(`config ${sub}: not implemented yet`);
  return 1;
}
