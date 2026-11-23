// `deliver config <sub>`: the command logic, kept out of deliver.mjs. Returns an exit code; never calls process.exit.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH } from './config.mjs';
import { readDoc, getPath, setPath, unsetPath, validateChange, remainingErrors, effective, loosensDocs, errorPaths, writeDoc, parseValue, diffLines } from './configedit.mjs';
import { SCHEMA, GROUPS, entry, keysOf, nearest, renderExplain, renderDocs, renderList, unavailable } from './configschema.mjs';
import { walk } from './wizard.mjs';
import { FACTORY_KEYS, fileProblems, fileNotes, outsideFile } from './factorycheck.mjs';

function explain({ args, opt, io }) {
  const file = opt.local ? 'local' : 'project';
  if (opt.docs) { io.out(renderDocs(file)); return 0; }
  if (opt.list) { io.out(opt.json ? JSON.stringify(keysOf(file).map((k) => entry(k, file)), null, 2) : renderList(file)); return 0; }
  const key = args[0];
  if (!key) { io.err('explain needs a key, or --list or --docs'); return 1; }
  const e = entry(key, file);
  if (!e) {
    return unknownKey(io, key, file);
  }
  io.out(opt.json ? JSON.stringify(e, null, 2) : renderExplain(e));
  return 0;
}

function unknownKey(io, key, kind) {
  const near = nearest(key, kind, 3);
  io.err(`unknown key "${key}"${near.length ? `; did you mean ${near.join(', ')}?` : ''}`);
  return 1;
}

// Shared by set and unset: resolve the key, build the candidate, validate, guard loosening, write, re-parse.
async function change({ sub, args, opt, root, home, io, tty }) {
  const kind = opt.local ? 'local' : 'project';
  const key = args[0];
  if (!key || (sub === 'set' && args.length !== 2)) { io.err(sub === 'set' ? 'usage: config set <key> <json-value> [--local]' : 'usage: config unset <key> [--local]'); return 1; }
  const e = entry(key, kind);
  if (!e) {
    return unknownKey(io, key, kind);
  }
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
  const reason = loosensDocs(e, before, after, kind);
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

// Draft file for `init --from-draft`: a regular JSON file under 64 KiB, never a symlink. O_NONBLOCK so a FIFO cannot hang the open.
function readDraft(f) {
  let fd;
  try { fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (x) {
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

// Keys named by parser errors (project "key: message", local "key must ..."), mapped to the nearest schema key at or above them.
const failingKeys = (errors, kind) => [...new Set(errors.flatMap(errorPaths).map((k) => {
  const n = k.replace(/\[\d+\]/g, '');
  return keysOf(kind).filter((p) => n === p || n.startsWith(`${p}.`)).sort((a, b) => b.length - a.length)[0];
}).filter(Boolean))];

// One gate entry per sensitive key whose effective value loosens between `base` and `final`; never merged by reason text.
// `done` only when the person typed yes during the walk for exactly the value that is now in the document.
export function gateKeys(entries, base, final, confirmed, kind) {
  const out = new Map();
  for (const e of entries.filter((x) => x.sensitive).sort((p, q) => !!p.alias - !!q.alias)) { // alias spellings last
    const key = e.alias ? e.alias.to : e.path;
    const reason = out.has(key) ? null : loosensDocs(e, base, final, kind);
    if (reason) out.set(key, { key, reason, done: confirmed[key] !== undefined && confirmed[key] === JSON.stringify(getPath(final, key) ?? null) });
  }
  return [...out.values()];
}

// What `factory run` would refuse for from this file alone, then what only the repository and the machine can show.
function checklist(io, doc) {
  const lines = ['factory checklist:'];
  const problems = fileProblems(effective(doc, 'project'));
  if (!problems.length) lines.push('  this file meets the checks factory run makes from the file alone');
  for (const x of problems) lines.push(`  ${x.id}: ${x.why}`, `    fix: ${x.fix}`);
  for (const x of fileNotes(effective(doc, 'project'))) lines.push(`  note: ${x.why}`);
  lines.push('check outside this file:');
  for (const x of outsideFile()) lines.push(`  - ${x.what}`, `    run: ${x.command}`);
  io.out(lines.join('\n'));
}

// init and edit: walk the keys, show the diff, ask once, write.
async function wizard({ sub, args, opt, root, home, io, tty }) {
  const kind = opt.local ? 'local' : 'project';
  if (!tty) { io.err(`config ${sub} needs a terminal; from a script use "deliver config set <key> <json-value>"`); return 1; }
  if (opt.profile !== undefined && !['basic', 'factory'].includes(opt.profile)) { io.err(`unknown profile "${opt.profile}"; use basic or factory`); return 1; }
  const factory = opt.profile === 'factory';
  if (factory && opt.local) { io.err('--profile factory edits the project file; leave out --local'); return 1; }
  const file = opt.local ? path.join(home, 'config.json') : path.join(root, CONFIG_PATH);
  let cur, start;
  try { cur = readDoc(file); } catch (x) { io.err(x.message); return 1; }
  if (!isPlain(cur.doc)) { io.err(`${file} must be a JSON object`); return 1; }
  if (sub === 'init') {
    if (cur.exists) { io.err(`${file} already exists; use "deliver config edit${opt.local ? ' --local' : ''}"`); return 1; }
    try { start = opt['from-draft'] ? readDraft(opt['from-draft']) : {}; } catch (x) { io.err(x.message); return 1; }
  } else {
    if (!cur.exists) { io.err(`${file} does not exist; use "deliver config init${opt.local ? ' --local' : ''}"`); return 1; }
    start = cur.doc;
  }
  let only = args[0];
  if (only && !keysOf(kind).includes(only) && !GROUPS.includes(only)) {
    const near = nearest(only, kind, 3);
    io.err(`unknown key or group "${only}"${near.length ? `; did you mean ${near.join(', ')}?` : ''}`);
    return 1;
  }
  const oe = only ? entry(only, kind) : null;
  if (oe?.alias) { io.out(`${only} is an alias of ${oe.alias.to} (its older spelling); editing ${oe.alias.to}`); only = oe.alias.to; }
  // A key inside an opt-in block (readiness.min_level) is never offered while the block is absent; say how to turn it on.
  const block = only ? SCHEMA.find((x) => x.file === kind && x.type === 'object-null' && only.startsWith(`${x.path}.`)) : null;
  if (block && getPath(start, block.path) === undefined) {
    io.err(`${only} applies only when the ${block.path} block is present, and the ${block.path} block is not enabled in ${file}; enable it first with "deliver config edit ${block.path}" (answer y)`);
    return 1;
  }
  const empty = {};
  const problems = validateChange(empty, start, kind).errors;
  const unknown = problems.filter((m) => m.startsWith('config:') || (kind === 'local' && /^unknown key/.test(m)));
  if (sub === 'init' && unknown.length) { io.err(`draft not used: ${unknown.join('; ')}`); return 1; }
  if (problems.length) io.out(`${file} has problems:\n${problems.map((m) => `  ${m}`).join('\n')}`);
  const entries = GROUPS.flatMap((g) => SCHEMA.filter((x) => x.file === kind && x.group === g));
  // A key this build cannot accept is never offered; say so once.
  const off = entries.filter((x) => unavailable(x));
  for (const x of off) {
    if (only === x.path) { io.err(`${x.path} is unavailable: ${unavailable(x)}`); return 1; }
    io.out(`${x.path} is unavailable: ${unavailable(x)}; skipped`);
  }
  // The factory profile walks its own keys in its own order (readiness is the opt-in switch for readiness.min_level).
  const walked = factory ? ['verification.required', 'readiness', ...FACTORY_KEYS.slice(1)].map((k) => entry(k, kind)).filter(Boolean) : entries.filter((x) => !unavailable(x));
  const r = await walk({
    entries: walked, doc: start, io, only, first: only ? [] : failingKeys(problems, kind),
    validateChange: (b, a) => validateChange(b, a, kind),
    loosens: (e, b, a) => loosensDocs(e, b, a, kind),
  });
  const closedMsg = () => { io.err('input closed; nothing written'); return 1; };
  if (r.closed) return closedMsg();
  const base = sub === 'init' ? empty : cur.doc;
  if (r.quit) { io.out('nothing written'); if (factory) checklist(io, base); return 0; }
  if (JSON.stringify(r.doc) === JSON.stringify(base)) { io.out('no changes; nothing written'); if (factory) checklist(io, base); return 0; }
  const v = validateChange(base, r.doc, kind);
  if (!v.ok) { io.err(`not written: ${v.errors.join('; ')}`); return 1; }
  // Every sensitive loosening between the file as it is on disk (empty for init) and the result needs a typed yes,
  // including values that came in from a draft or were already in the file before this walk touched them.
  const risky = gateKeys(entries, base, r.doc, r.confirmed, kind);
  io.out(sub === 'init' ? JSON.stringify(r.doc, null, 2).split('\n').map((l) => `+ ${l}`).join('\n') : diffLines(base, r.doc).join('\n'));
  if (risky.length) io.out(`sensitive changes: ${risky.map((x) => `${x.key}: ${x.reason}`).join('; ')}`);
  for (const x of risky.filter((y) => !y.done)) {
    const a = await io.ask(`${x.key} ${x.reason}. Type yes to apply: `);
    if (a === null || a === undefined) return closedMsg();
    if (String(a).trim() !== 'yes') { io.err(`not written: ${x.key} was not confirmed`); return 1; }
  }
  const yAns = await io.ask(`Write ${file}? (y/n) `);
  if (yAns === null || yAns === undefined) return closedMsg();
  const yn = String(yAns).trim().toLowerCase();
  if (yn !== 'y' && yn !== 'yes') { io.out('nothing written'); if (factory) checklist(io, base); return 0; }
  try { writeDoc(file, r.doc, { sha: cur.sha, mode: opt.local ? 0o600 : 0o644 }); } catch (x) { io.err(x.message); return 1; }
  io.out(`wrote ${file}`);
  io.out(opt.local ? 'next: nothing to commit; the next factory run reads this file' : `next: commit ${CONFIG_PATH} and merge it to the base branch`);
  if (factory) checklist(io, r.doc);
  return 0;
}

export const SUBCOMMANDS = ['explain', 'set', 'unset', 'init', 'edit'];

export async function runConfigCommand({ sub, args = [], opt = {}, root, home, io, tty }) {
  if (sub === 'explain') return explain({ args, opt, io });
  if (sub === 'set' || sub === 'unset') return change({ sub, args, opt, root, home, io, tty });
  if (sub === 'init' || sub === 'edit') return wizard({ sub, args, opt, root, home, io, tty });
  io.err(`unknown config subcommand "${sub}"; use one of: ${SUBCOMMANDS.join(', ')}`);
  return 1;
}
