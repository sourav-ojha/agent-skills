// Verdict files: FACTORY_HOME/verdicts/<owner>__<repo>/<FEATURE-ID>.<sha>.json. Zero dependencies.
// A verdict binds one feature to one exact commit (40-hex sha) and to the scenarios_hash and criteria_hash it was run
// against. Only the driver writes these (outside the builder's reach). Reading is fail-closed: anything missing, oversized,
// symlinked, not a regular file, not JSON, of the wrong shape, carrying unknown fields, or naming a different feature/sha
// than its path reads as null and never throws. A `pass` verdict must be internally consistent (non-empty results, every
// result `pass` and not flaky); otherwise the file is treated as invalid.
import fs from 'node:fs';
import path from 'node:path';
import { factoryHome, writeJsonAtomic } from './factoryhome.mjs';
import { checkRepoKey, SCEN_ID, CRIT_ID } from './scenarios.mjs';
import { FEATURE_ID } from './queue.mjs';

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_ID = 64;
const MAX_BYTES = 256 * 1024;
const MAX_RESULTS = 1000;
const MAX_COVERS = 50;
const MAX_AT = 40;
const DOC_KEYS = ['feature', 'sha', 'scenarios_hash', 'criteria_hash', 'results', 'verdict', 'at'];
const RESULT_KEYS = ['id', 'covers', 'status', 'flaky'];
const STATUSES = ['pass', 'fail', 'blocked'];

const validId = (id) => typeof id === 'string' && id.length <= MAX_ID && FEATURE_ID.test(id);
const exactKeys = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype
  && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

function validResult(r) {
  return exactKeys(r, RESULT_KEYS)
    && typeof r.id === 'string' && SCEN_ID.test(r.id)
    && Array.isArray(r.covers) && r.covers.length > 0 && r.covers.length <= MAX_COVERS && r.covers.every((c) => typeof c === 'string' && CRIT_ID.test(c))
    && STATUSES.includes(r.status)
    && typeof r.flaky === 'boolean';
}

// Strict shape check shared by writer and reader, so the writer can never produce a file the reader rejects.
export function validVerdict(doc) {
  if (!exactKeys(doc, DOC_KEYS)) return false;
  if (!validId(doc.feature) || typeof doc.sha !== 'string' || !SHA.test(doc.sha)) return false;
  if (typeof doc.scenarios_hash !== 'string' || !HASH.test(doc.scenarios_hash) || typeof doc.criteria_hash !== 'string' || !HASH.test(doc.criteria_hash)) return false;
  if (doc.verdict !== 'pass' && doc.verdict !== 'fail') return false;
  if (typeof doc.at !== 'string' || doc.at.length > MAX_AT || Number.isNaN(Date.parse(doc.at))) return false;
  if (!Array.isArray(doc.results) || doc.results.length === 0 || doc.results.length > MAX_RESULTS || !doc.results.every(validResult)) return false;
  if (doc.verdict === 'pass' && !doc.results.every((r) => r.status === 'pass' && r.flaky === false)) return false;
  return true;
}

export function verdictPath(repoKey, id, sha) {
  checkRepoKey(repoKey);
  if (!validId(id)) throw new Error('invalid feature id (expected FEATURE-<n>)');
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('invalid sha (expected 40 lowercase hex characters)');
  return path.join(factoryHome(), 'verdicts', repoKey, `${id}.${sha}.json`);
}

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// Returns the file written. Throws on an invalid doc or a symlinked verdicts directory.
export function writeVerdict(repoKey, doc) {
  if (!validVerdict(doc)) throw new Error('invalid verdict document');
  const file = verdictPath(repoKey, doc.feature, doc.sha);
  const root = path.join(factoryHome(), 'verdicts');
  for (const d of [root, path.dirname(file)]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    if (isLink(d) || !fs.lstatSync(d).isDirectory()) throw new Error('refusing to write: verdicts directory is a symlink');
  }
  writeJsonAtomic(file, doc);
  return file;
}

// doc or null. Never throws.
export function readVerdict(repoKey, id, sha) {
  let fd;
  try {
    const file = verdictPath(repoKey, id, sha);
    const root = path.join(factoryHome(), 'verdicts');
    for (const d of [root, path.dirname(file)]) { const st = fs.lstatSync(d); if (st.isSymbolicLink() || !st.isDirectory()) return null; }
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let n = 0;
    for (;;) { const r = fs.readSync(fd, buf, n, buf.length - n, null); if (r === 0) break; n += r; if (n > MAX_BYTES) return null; }
    const doc = JSON.parse(buf.subarray(0, n).toString('utf8'));
    if (!validVerdict(doc) || doc.feature !== id || doc.sha !== sha) return null;
    return doc;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// True only for a shape-valid pass verdict bound to exactly this sha and both hashes, with every result passing and not flaky.
export function verdictMatches(doc, want) {
  if (!validVerdict(doc) || !want || typeof want !== 'object') return false;
  const { sha, scenariosHash, criteriaHash } = want;
  if (typeof sha !== 'string' || typeof scenariosHash !== 'string' || typeof criteriaHash !== 'string') return false;
  return doc.sha === sha && doc.scenarios_hash === scenariosHash && doc.criteria_hash === criteriaHash
    && doc.verdict === 'pass' && doc.results.length > 0 && doc.results.every((r) => r.status === 'pass' && r.flaky !== true);
}
