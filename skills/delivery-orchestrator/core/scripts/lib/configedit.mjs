// Editing core for `deliver config`: read, change, validate and write one JSON config file. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseConfig } from './config.mjs';
import { parseLocalConfig } from './localconfig.mjs';
import { CLASSIFIER_STATUS } from './limits.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const clone = (v) => JSON.parse(JSON.stringify(v));

// -> { doc, sha, exists }. Throws on invalid JSON, a symlink, or a non-regular file. A missing file is { doc: {}, sha: null }.
export function readDoc(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { doc: {}, sha: null, exists: false }; throw e; }
  if (st.isSymbolicLink()) throw new Error(`${file} is a symlink; refusing to use it`);
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  const buf = fs.readFileSync(file);
  let doc;
  try { doc = JSON.parse(buf.toString('utf8')); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
  return { doc, sha: sha256(buf), exists: true };
}

export function getPath(doc, p) {
  let o = doc;
  for (const k of p.split('.')) { if (!isObj(o) || !(k in o)) return undefined; o = o[k]; }
  return o;
}

export function setPath(doc, p, v) {
  const out = clone(doc);
  const ks = p.split('.');
  let o = out;
  ks.slice(0, -1).forEach((k, i) => {
    if (o[k] === undefined) o[k] = {};
    else if (!isObj(o[k])) throw new Error(`${ks.slice(0, i + 1).join('.')} is not an object`);
    o = o[k];
  });
  o[ks.at(-1)] = clone(v);
  return out;
}

export function unsetPath(doc, p) {
  const out = clone(doc);
  const ks = p.split('.');
  const trail = [out];
  for (const k of ks.slice(0, -1)) { const n = trail.at(-1)?.[k]; if (!isObj(n)) return out; trail.push(n); }
  delete trail.at(-1)[ks.at(-1)];
  for (let i = trail.length - 1; i > 0; i--) if (Object.keys(trail[i]).length === 0) delete trail[i - 1][ks[i - 1]];
  return out;
}

export const parseValue = (text) => { try { return JSON.parse(text); } catch { return text; } };

const parseDoc = (doc, kind) => (kind === 'local' ? parseLocalConfig(doc, { classifierReal: CLASSIFIER_STATUS === 'real' }) : parseConfig(doc));

// Errors the parser reports for `after` that it did not report for `before`.
export function validateChange(before, after, kind) {
  const had = new Set(parseDoc(before, kind).errors);
  const errors = parseDoc(after, kind).errors.filter((m) => !had.has(m));
  return { ok: errors.length === 0, errors };
}

// Errors present both before and after (not caused by the change).
export function remainingErrors(before, after, kind) {
  const had = new Set(parseDoc(before, kind).errors);
  return parseDoc(after, kind).errors.filter((m) => had.has(m));
}

export const effective = (doc, kind) => parseDoc(doc, kind).config;

// `before` and `after` are effective configs (the parser's `config`). Returns a one-line reason, or null.
export function loosens(e, before, after) {
  const p = e.alias ? e.alias.to : e.path;
  const b = getPath(before, p), a = getPath(after, p);
  const added = (x, y) => (Array.isArray(y) ? y : []).filter((i) => !(Array.isArray(x) ? x : []).some((j) => JSON.stringify(j) === JSON.stringify(i)));
  switch (p) {
    case 'autonomy.level': return b !== 'L1' && a === 'L1' ? 'allows squash-merge without a person (autonomy L1)' : null;
    case 'merge.allow_tier3': return b !== true && a === true ? 'allows merging tier-3 work (auth, data, migrations, public API)' : null;
    case 'checks.allow_without_ci': return b !== true && a === true ? 'allows merging on local evidence when no CI check exists' : null;
    case 'protected_branches': case 'hold_paths': {
      const gone = added(a, b);
      return gone.length ? `removes ${p} entries (${gone.join(', ')}), so more branches or paths can be merged without a person` : null;
    }
    case 'checks.ignored': { const n = added(b, a); return n.length ? `ignores more CI checks (${n.join(', ')}), which can then never hold a feature` : null; }
    case 'local_checks': return added(b, a).length ? 'adds or changes a local check, which runs as you outside the sandbox' : null;
    case 'verification.required': return b === true && a !== true ? 'turns off the verification gate' : null;
    case 'verification.scenario_approval': return b === 'human' && a === 'auto' ? 'lets verification scenarios be accepted without a person' : null;
    case 'budgets.feature.tokens': case 'budgets.feature.turns': case 'budgets.day_tokens': {
      const raised = (a === null && b !== null && b !== undefined) || (typeof a === 'number' && typeof b === 'number' && a > b);
      return raised ? `raises the ${p} cap, so runs can spend more` : null;
    }
    default: return null;
  }
}

// Line diff of the pretty-printed documents: '-' for removed lines, '+' for added.
export function diffLines(before, after) {
  const x = JSON.stringify(before, null, 2).split('\n'), y = JSON.stringify(after, null, 2).split('\n');
  const m = x.length, n = y.length;
  const t = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && x[i] === y[j]) { i++; j++; } else if (i < m && (j === n || t[i + 1][j] >= t[i][j + 1])) out.push(`- ${x[i++]}`); else out.push(`+ ${y[j++]}`);
  }
  return out;
}

// Atomic write: refuses a symlinked file or folder, and a file that changed on disk since it was read (`sha`; null = must not exist).
export function writeDoc(file, doc, { sha, mode }) {
  const dir = path.dirname(file);
  if (isLink(dir)) throw new Error(`refusing to write: ${dir} is a symlink`);
  fs.mkdirSync(dir, { recursive: true });
  if (isLink(dir)) throw new Error(`refusing to write: ${dir} is a symlink`);
  if (isLink(file)) throw new Error(`refusing to write: ${file} is a symlink`);
  let now = null;
  try { now = sha256(fs.readFileSync(file)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (now !== (sha ?? null)) throw new Error(`refusing to write: ${file} changed on disk since it was read`);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode, flag: 'wx' });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } throw e; }
}
