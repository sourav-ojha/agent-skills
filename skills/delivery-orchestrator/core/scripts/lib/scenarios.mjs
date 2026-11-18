// Hidden-scenario files: schema lint, canary, hash, approval, storage. Zero dependencies.
// Lint output reaches the driver's terminal (and possibly builder-visible logs): problems carry IDs and counts ONLY,
// never scenario text, data, paths or the canary. Free-form values are never echoed; unsafe IDs are reported by index.
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { factoryHome, writeJsonAtomic, readJson } from './factoryhome.mjs';
import { FEATURE_ID } from './queue.mjs';

const CRIT_ID = /^(AC|EC|ER)-[1-9]\d{0,3}$/;
const SCEN_ID = /^S-\d{1,4}$/;
const CANARY = /^fx-[0-9a-f]{6}$/;
const KINDS = ['api', 'ui'];

export const newCanary = () => `fx-${randomBytes(3).toString('hex')}`;

const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
};
// Approval is metadata about the content, not content: it is excluded so approving does not change the hash.
export const scenariosHash = (doc) => {
  const { approved: _a, ...rest } = doc ?? {};
  return `sha256:${createHash('sha256').update(canonical(rest)).digest('hex')}`;
};

export function approve(doc, by) {
  return { ...doc, approved: { by: String(by), at: new Date().toISOString() } };
}
export const isCurrentApproved = (doc, currentHash) => {
  const a = doc?.approved;
  return !!(a && typeof a.by === 'string' && a.by && typeof a.at === 'string' && a.at)
    && typeof doc.criteria_hash === 'string' && doc.criteria_hash === currentHash;
};

const segs = (p) => p.split('/');
function matchesContract(contract, method, rawPath) {
  if (typeof method !== 'string' || typeof rawPath !== 'string' || !rawPath.startsWith('/')) return false;
  const p = segs(rawPath.split(/[?#]/)[0]);
  return contract.some((c) => {
    if (c.method !== method.toUpperCase()) return false;
    const q = segs(c.path);
    return q.length === p.length && q.every((s, i) => (/^\{[^/}]+\}$/.test(s) ? p[i] !== '' : s === p[i]));
  });
}

const nonEmptyArr = (a) => Array.isArray(a) && a.length > 0;
const dataOf = (s) => canonical([s.setup, s.request, s.steps, s.expect]);

export function lintScenarios(doc, criteria, currentHash) {
  const problems = [];
  if (!criteria || criteria.ok !== true) {
    const n = Array.isArray(criteria?.errors) ? criteria.errors.length : 0;
    return { ok: false, problems: [`criteria extraction has errors (${n})`] };
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.scenarios)) return { ok: false, problems: ['scenario file has no scenarios array'] };
  if (doc.criteria_hash !== currentHash) problems.push('criteria_hash is not current');
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
      else if (!matchesContract(criteria.contract, r.method, r.path)) problems.push(`scenario ${label}: api request is not an endpoint in the HTTP contract`);
    } else if (s.kind === 'ui') {
      if (!nonEmptyArr(s.steps) || !nonEmptyArr(s.expect)) problems.push(`scenario ${label}: ui scenario needs steps and expect`);
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

function checkRepoKey(k) {
  if (typeof k !== 'string' || !k || k === '.' || k === '..' || /[\\/\0]/.test(k)) throw new Error('invalid repo key');
}
export function scenarioPath(repoKeyStr, featureId) {
  checkRepoKey(repoKeyStr);
  if (typeof featureId !== 'string' || !FEATURE_ID.test(featureId) || featureId.includes('\n')) throw new Error('invalid feature id (expected FEATURE-<n>)');
  return path.join(factoryHome(), 'scenarios', repoKeyStr, `${featureId}.json`);
}
export const saveScenarios = (repoKeyStr, featureId, doc) => writeJsonAtomic(scenarioPath(repoKeyStr, featureId), doc);
export const loadScenarios = (repoKeyStr, featureId) => readJson(scenarioPath(repoKeyStr, featureId));
