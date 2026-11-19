// Hidden-scenario files: schema lint, canary, hash, approval, storage. Zero dependencies.
// Lint output reaches the driver's terminal (and possibly builder-visible logs): problems carry IDs and counts ONLY,
// never scenario text, data, paths or the canary. Free-form values are never echoed; unsafe IDs are reported by index.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { factoryHome, writeJsonAtomic, readJson } from './factoryhome.mjs';
import { FEATURE_ID } from './queue.mjs';

export const CRIT_ID = /^(AC|EC|ER)-[1-9]\d{0,3}$/;
export const SCEN_ID = /^S-\d{1,4}$/;
const CANARY = /^fx-[0-9a-f]{6}$/;
const KINDS = ['api', 'ui'];

export const newCanary = () => `fx-${randomBytes(3).toString('hex')}`;

const MAX_DEPTH = 50;
const BY = /^[\w.@-]{1,64}$/;
// Accepted assertion shapes: ONE place. Task 8's verification engine must execute exactly this list.
//   { status: <integer 100-599> }
//   { header: <name>, equals: <string> } or { header: <name>, matches: <non-empty regex string> }
//   { json_path: <path>, <exactly one of equals|contains|not_contains|count|matches>: <value> }
// An empty-string `contains` or `matches` is vacuous (always true on strings) and is refused. Every api scenario must also
// carry at least one `status` assertion (lintScenarios), so an error response cannot pass on body assertions alone.
export const JSON_PATH_OPS = ['equals', 'contains', 'not_contains', 'count', 'matches'];
export const validAssertion = (a) => {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const keys = Object.keys(a);
  if ('status' in a) return keys.length === 1 && Number.isInteger(a.status) && a.status >= 100 && a.status <= 599;
  if ('header' in a) {
    const ops = keys.filter((k) => k !== 'header');
    return typeof a.header === 'string' && a.header !== '' && ops.length === 1 && (ops[0] === 'equals' || ops[0] === 'matches') && typeof a[ops[0]] === 'string'
      && !(ops[0] === 'matches' && a.matches === '');
  }
  if ('json_path' in a) {
    const ops = keys.filter((k) => k !== 'json_path');
    return typeof a.json_path === 'string' && a.json_path !== '' && ops.length === 1 && JSON_PATH_OPS.includes(ops[0])
      && !(ops[0] === 'contains' && a.contains === '')
      && !(ops[0] === 'matches' && (typeof a.matches !== 'string' || a.matches === ''));
  }
  return false;
};
const tooDeep = (v, d = 0) => {
  if (d > MAX_DEPTH) return true;
  if (v && typeof v === 'object') return Object.values(v).some((x) => tooDeep(x, d + 1));
  return false;
};
// undefined-valued keys are skipped so the hash survives a JSON round-trip (save -> load).
const canonical = (v) => {
  if (tooDeep(v)) throw new Error('scenario data too deeply nested');
  const walk = (x) => {
    if (Array.isArray(x)) return `[${x.map((e) => (e === undefined || typeof e === 'function' ? 'null' : walk(e))).join(',')}]`;
    if (x && typeof x === 'object') return `{${Object.keys(x).filter((k) => x[k] !== undefined && typeof x[k] !== 'function').sort().map((k) => `${JSON.stringify(k)}:${walk(x[k])}`).join(',')}}`;
    return JSON.stringify(x) ?? 'null';
  };
  return walk(v);
};
// Approval is metadata about the content, not content: it is excluded so approving does not change the hash.
export const scenariosHash = (doc) => {
  const { approved: _a, ...rest } = doc ?? {};
  return `sha256:${createHash('sha256').update(canonical(rest)).digest('hex')}`;
};

// Policy (auto vs human approval) is the caller's job. `approved` is a claim, not proof: the factory run gate must
// re-lint the doc as well as call isCurrentApproved. The approval is bound to the scenario content via scenarios_hash.
export function approve(doc, by) {
  if (typeof by !== 'string' || !BY.test(by)) throw new Error('invalid approver (expected 1-64 chars of [A-Za-z0-9_.@-])');
  return { ...doc, approved: { by, at: new Date().toISOString(), scenarios_hash: scenariosHash(doc) } };
}
export const isCurrentApproved = (doc, currentHash) => {
  const a = doc?.approved;
  if (typeof currentHash !== 'string' || !currentHash) return false;
  if (!a || typeof a.by !== 'string' || !BY.test(a.by) || typeof a.at !== 'string' || Number.isNaN(Date.parse(a.at))) return false;
  if (typeof doc.criteria_hash !== 'string' || doc.criteria_hash !== currentHash) return false;
  try { return a.scenarios_hash === scenariosHash(doc); } catch { return false; }
};

const segs = (p) => p.split('/');
function matchesContract(contract, method, rawPath) {
  if (typeof method !== 'string' || typeof rawPath !== 'string' || !rawPath.startsWith('/')) return false;
  const p = segs(rawPath.split(/[?#]/)[0]);
  if (p.some((x) => x === '.' || x === '..')) return false;
  return contract.some((c) => {
    if (c.method !== method.toUpperCase()) return false;
    const q = segs(c.path);
    return q.length === p.length && q.every((s, i) => (/^\{[^/}]+\}$/.test(s)
      ? p[i] !== '' && !/%2e|%2f|%5c/i.test(p[i])
      : s === p[i]));
  });
}

const nonEmptyArr = (a) => Array.isArray(a) && a.length > 0;
const dataOf = (s) => canonical([s.setup, s.request, s.steps, s.expect]);
const strList = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.trim() !== '' && x.length <= 500);

export function lintScenarios(doc, criteria, currentHash) {
  const problems = [];
  if (!criteria || criteria.ok !== true) {
    const n = Array.isArray(criteria?.errors) ? criteria.errors.length : 0;
    return { ok: false, problems: [`criteria extraction has errors (${n})`] };
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.scenarios)) return { ok: false, problems: ['scenario file has no scenarios array'] };
  if (typeof currentHash !== 'string' || typeof doc.criteria_hash !== 'string' || doc.criteria_hash !== currentHash) problems.push('criteria_hash is not current');
  if (typeof doc.canary !== 'string' || !CANARY.test(doc.canary)) problems.push('canary is missing or malformed');

  const required = [...criteria.ac, ...criteria.ec, ...criteria.er].map((x) => x.id);
  const known = new Set(required);
  const counts = new Map(required.map((id) => [id, 0]));
  const seenIds = new Set();
  let canaryHit = false;
  let unsafeCovers = 0;

  doc.scenarios.forEach((s, i) => {
    const label = s && typeof s.id === 'string' && SCEN_ID.test(s.id) ? s.id : `#${i + 1}`;
    if (!s || typeof s !== 'object') { problems.push(`scenario ${label}: not an object`); return; }
    if (tooDeep(s)) { problems.push(`scenario ${label}: data too deeply nested`); return; }
    if (typeof s.id !== 'string' || !SCEN_ID.test(s.id)) problems.push(`scenario ${label}: id is missing or not of the form S-<n>`);
    else if (seenIds.has(s.id)) problems.push(`scenario ${label}: duplicate id`);
    else seenIds.add(s.id);

    if (!nonEmptyArr(s.covers)) problems.push(`scenario ${label}: covers is empty`);
    else for (const c of new Set(s.covers)) {
      if (typeof c === 'string' && known.has(c)) counts.set(c, counts.get(c) + 1);
      else if (typeof c === 'string' && CRIT_ID.test(c)) problems.push(`scenario ${label}: covers unknown criterion ${c}`);
      else unsafeCovers++;
    }

    if (s.kind === 'api') {
      const r = s.request;
      if (!r || typeof r !== 'object' || !nonEmptyArr(s.assert)) problems.push(`scenario ${label}: api scenario needs request and assert`);
      else {
        if (!matchesContract(criteria.contract, r.method, r.path)) problems.push(`scenario ${label}: api request is not an endpoint in the HTTP contract`);
        const bad = s.assert.filter((a) => !validAssertion(a)).length;
        if (bad) problems.push(`scenario ${label}: ${bad} assertion(s) are not a recognised shape`);
        if (!s.assert.some((a) => validAssertion(a) && 'status' in a)) problems.push(`scenario ${label}: api scenario needs a status assertion`);
      }
      if (s.setup !== undefined) {
        if (!Array.isArray(s.setup)) problems.push(`scenario ${label}: setup must be an array of requests`);
        else s.setup.forEach((e, k) => {
          if (!e || typeof e !== 'object' || Array.isArray(e) || !matchesContract(criteria.contract, e.method, e.path)) problems.push(`scenario ${label}: setup request ${k + 1} is not an endpoint in the HTTP contract`);
        });
      }
    } else if (s.kind === 'ui') {
      if (!nonEmptyArr(s.steps) || !nonEmptyArr(s.expect)) problems.push(`scenario ${label}: ui scenario needs steps and expect`);
      else if (!strList(s.steps) || !strList(s.expect)) problems.push(`scenario ${label}: steps and expect entries must be non-empty strings (max 500 chars)`);
      if (s.setup !== undefined && !strList(s.setup)) problems.push(`scenario ${label}: setup entries must be non-empty strings (max 500 chars)`);
    } else problems.push(`scenario ${label}: kind must be api or ui`);

    if (typeof doc.canary === 'string' && CANARY.test(doc.canary) && dataOf(s).includes(doc.canary)) canaryHit = true;
  });

  if (unsafeCovers) problems.push(`${unsafeCovers} covers entr${unsafeCovers === 1 ? 'y is' : 'ies are'} not a criterion ID`);
  for (const [id, n] of counts) {
    if (n === 0) problems.push(`${id} is not covered`);
    else if (n > 3) problems.push(`${id} has ${n} scenarios (max 3)`);
  }
  if (CANARY.test(doc.canary ?? '') && !canaryHit) problems.push('canary does not appear in any scenario data');
  return { ok: problems.length === 0, problems };
}

const KEY_PART = /^[A-Za-z0-9._-]+$/;
export function checkRepoKey(k) {
  const parts = typeof k === 'string' ? k.split('__') : [];
  if (parts.length !== 2 || !parts.every((x) => KEY_PART.test(x) && x !== '.' && x !== '..')) throw new Error('invalid repo key (expected <owner>__<repo>)');
}
export function scenarioPath(repoKeyStr, featureId) {
  checkRepoKey(repoKeyStr);
  if (typeof featureId !== 'string' || !FEATURE_ID.test(featureId)) throw new Error('invalid feature id (expected FEATURE-<n>)');
  return path.join(factoryHome(), 'scenarios', repoKeyStr, `${featureId}.json`);
}
export function saveScenarios(repoKeyStr, featureId, doc) {
  const file = scenarioPath(repoKeyStr, featureId);
  if (!doc || doc.feature !== featureId) throw new Error('scenario doc feature does not match the feature id');
  // Private directory tree (0700) for what we create; writeJsonAtomic refuses symlinked dirs afterwards.
  const root = path.join(factoryHome(), 'scenarios');
  for (const d of [root, path.dirname(file)]) {
    try { if (!fs.lstatSync(d).isSymbolicLink()) continue; } catch { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); continue; }
    throw new Error('refusing to write: scenarios directory is a symlink');
  }
  writeJsonAtomic(file, doc);
}
// null = missing; throws (without file contents) when the file exists but is not valid JSON.
export function loadScenarios(repoKeyStr, featureId) {
  const file = scenarioPath(repoKeyStr, featureId);
  if (!fs.existsSync(file)) return null;
  const doc = readJson(file);
  if (doc === null) throw new Error(`scenario file for ${featureId} is corrupt`);
  return doc;
}
