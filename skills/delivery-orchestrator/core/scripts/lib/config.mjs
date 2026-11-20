// Project policy for the delivery-orchestrator, read once at init from a committed file. Zero dependencies.
// Every key is validated; an unknown key is an error, so a typo can never silently weaken a rule.
import { FEATURE_ID } from './queue.mjs';

export const CONFIG_PATH = '.product/delivery.json';
export const DEFAULT_PROTECTED = ['main', 'master', 'prod', 'production', 'release/*', 'release-*'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const strList = (v, at, errs, max = 100) => {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 200 || /[\u0000-\u001f]/.test(x))) { errs.push(`${at}: expected a list of up to ${max} short strings`); return []; }
  return v.map((x) => x.trim());
};
const relPath = (v) => typeof v === 'string' && v && !v.startsWith('/') && !v.split('/').includes('..');
// Local-only app URL: http://localhost:<port> or http://127.0.0.1:<port>, optional path. Never https, never another host.
export const isLocalUrl = (u) => typeof u === 'string' && /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}(?:\/[^\s@]*)?$/.test(u);
const keys = (o, allowed, at, errs) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) errs.push(`${at}: unknown key "${k}" (allowed: ${allowed.join(', ')})`); };

export function defaults() {
  return {
    version: 1,
    github: { account: null, host: 'github.com' },
    base: null,
    branch_prefix: 'feat/',
    features_dir: '.product/features',
    protected_branches: [...DEFAULT_PROTECTED],
    merge: { mode: 'pr-only', allow_tier3: false },
    checks: { required: [], ignored: [], allow_without_ci: false },
    local_checks: [],
    hold_paths: [],
    limits: { max_fix_rounds: 2, max_failures: 2, ci_budget_s: 1800 },
    implementer_notes: '',
    app: { setup: null, start: null, stop: null, base_url: null, ready: null, logs_dir: null, seed: null, env_example: null },
    tests: { setup: null, all: null, timeout_s: 900 },
    readiness: null, // null = not opted in
    verification: { required: false, scenario_approval: 'auto', session_timeout_s: { builder: 1800, author: 900 }, max_turns: { builder: 200, author: 40 }, model: { builder: null, author: null }, test_globs: [] },
  };
}

// Returns { config, errors }. `raw` is the parsed JSON (or undefined when there is no file).
export function parseConfig(raw) {
  const cfg = defaults();
  const errs = [];
  if (raw === undefined) return { config: cfg, errors: errs };
  if (!isObj(raw)) return { config: cfg, errors: ['config must be a JSON object'] };
  keys(raw, ['version', 'github', 'base', 'branch_prefix', 'features_dir', 'protected_branches', 'merge', 'checks', 'local_checks', 'hold_paths', 'limits', 'implementer_notes', 'app', 'tests', 'readiness', 'verification'], 'config', errs);
  if (raw.version !== undefined && raw.version !== 1) errs.push('version: only 1 is supported');
  if (raw.github !== undefined) {
    if (!isObj(raw.github)) errs.push('github: expected an object');
    else {
      keys(raw.github, ['account', 'host'], 'github', errs);
      if (raw.github.account !== undefined && raw.github.account !== null) { if (typeof raw.github.account === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(raw.github.account)) cfg.github.account = raw.github.account; else errs.push('github.account: a GitHub login (letters, digits, hyphens)'); }
      if (raw.github.host !== undefined) { if (typeof raw.github.host === 'string' && /^[A-Za-z0-9.-]{1,100}$/.test(raw.github.host)) cfg.github.host = raw.github.host; else errs.push('github.host: a hostname such as github.com'); }
    }
  }
  if (raw.base !== undefined && raw.base !== null) { if (typeof raw.base === 'string' && REF.test(raw.base) && !raw.base.includes('..')) cfg.base = raw.base; else errs.push('base: a branch name'); }
  if (raw.branch_prefix !== undefined) { if (typeof raw.branch_prefix === 'string' && (raw.branch_prefix === '' || /^[a-z0-9][a-z0-9._-]*\/$/.test(raw.branch_prefix))) cfg.branch_prefix = raw.branch_prefix; else errs.push('branch_prefix: like "feat/" (lower-case, ends with a slash) or ""'); }
  if (raw.features_dir !== undefined) { if (typeof raw.features_dir === 'string' && raw.features_dir && !raw.features_dir.startsWith('/') && !raw.features_dir.split('/').includes('..')) cfg.features_dir = raw.features_dir; else errs.push('features_dir: a relative path inside the repository'); }
  if (raw.protected_branches !== undefined) cfg.protected_branches = strList(raw.protected_branches, 'protected_branches', errs, 50);
  if (raw.merge !== undefined) {
    if (!isObj(raw.merge)) errs.push('merge: expected an object');
    else {
      keys(raw.merge, ['mode', 'allow_tier3'], 'merge', errs);
      if (raw.merge.mode !== undefined) { if (['pr-only', 'squash'].includes(raw.merge.mode)) cfg.merge.mode = raw.merge.mode; else errs.push('merge.mode: "pr-only" or "squash"'); }
      if (raw.merge.allow_tier3 !== undefined) { if (typeof raw.merge.allow_tier3 === 'boolean') cfg.merge.allow_tier3 = raw.merge.allow_tier3; else errs.push('merge.allow_tier3: true or false'); }
    }
  }
  if (raw.checks !== undefined) {
    if (!isObj(raw.checks)) errs.push('checks: expected an object');
    else {
      keys(raw.checks, ['required', 'ignored', 'allow_without_ci'], 'checks', errs);
      if (raw.checks.required !== undefined) cfg.checks.required = strList(raw.checks.required, 'checks.required', errs);
      if (raw.checks.ignored !== undefined) cfg.checks.ignored = strList(raw.checks.ignored, 'checks.ignored', errs);
      if (raw.checks.allow_without_ci !== undefined) { if (typeof raw.checks.allow_without_ci === 'boolean') cfg.checks.allow_without_ci = raw.checks.allow_without_ci; else errs.push('checks.allow_without_ci: true or false'); }
    }
  }
  if (raw.local_checks !== undefined) {
    if (!Array.isArray(raw.local_checks) || raw.local_checks.length > 10) errs.push('local_checks: a list of up to 10 {name, command, timeout_s}');
    else cfg.local_checks = raw.local_checks.map((c, i) => {
      const at = `local_checks[${i}]`;
      if (!isObj(c)) { errs.push(`${at}: expected an object`); return null; }
      keys(c, ['name', 'command', 'timeout_s'], at, errs);
      if (typeof c.name !== 'string' || !/^[\w .:-]{1,60}$/.test(c.name)) errs.push(`${at}.name: 1-60 letters, digits, spaces, . : _ -`);
      const cmd = strList(c.command, `${at}.command`, errs, 30); // argv, never a shell string
      if (!cmd.length) errs.push(`${at}.command: an argument list such as ["npm","test"]`);
      const t = c.timeout_s === undefined ? 900 : c.timeout_s;
      if (!Number.isInteger(t) || t < 1 || t > 3600) errs.push(`${at}.timeout_s: an integer 1-3600`);
      return { name: c.name, command: cmd, timeout_s: t };
    }).filter(Boolean);
  }
  if (raw.hold_paths !== undefined) cfg.hold_paths = strList(raw.hold_paths, 'hold_paths', errs, 50);
  if (raw.limits !== undefined) {
    if (!isObj(raw.limits)) errs.push('limits: expected an object');
    else {
      keys(raw.limits, ['max_fix_rounds', 'max_failures', 'ci_budget_s'], 'limits', errs);
      const bounds = { max_fix_rounds: [0, 5], max_failures: [1, 10], ci_budget_s: [1, 86400] };
      for (const [k, [lo, hi]] of Object.entries(bounds)) if (raw.limits[k] !== undefined) { if (Number.isInteger(raw.limits[k]) && raw.limits[k] >= lo && raw.limits[k] <= hi) cfg.limits[k] = raw.limits[k]; else errs.push(`limits.${k}: an integer ${lo}-${hi}`); }
    }
  }
  if (raw.implementer_notes !== undefined) { if (typeof raw.implementer_notes === 'string' && raw.implementer_notes.length <= 500 && !/[\u0000-\u0008\u000b-\u001f]/.test(raw.implementer_notes)) cfg.implementer_notes = raw.implementer_notes; else errs.push('implementer_notes: text up to 500 characters'); }
  if (raw.app !== undefined) {
    if (!isObj(raw.app)) errs.push('app: expected an object');
    else {
      keys(raw.app, Object.keys(cfg.app), 'app', errs);
      for (const k of ['setup', 'start', 'stop', 'seed']) if (raw.app[k] !== undefined && raw.app[k] !== null) { const l = strList(raw.app[k], `app.${k}`, errs, 30); if (!l.length) errs.push(`app.${k}: an argument list such as ["npm","run","dev"]`); else cfg.app[k] = l; }
      if (raw.app.base_url !== undefined && raw.app.base_url !== null) { if (isLocalUrl(raw.app.base_url)) cfg.app.base_url = raw.app.base_url; else errs.push('app.base_url: http://localhost:<port> or http://127.0.0.1:<port>'); }
      for (const k of ['logs_dir', 'env_example']) if (raw.app[k] !== undefined && raw.app[k] !== null) { if (relPath(raw.app[k])) cfg.app[k] = raw.app[k]; else errs.push(`app.${k}: a relative path inside the repository`); }
      if (raw.app.ready !== undefined && raw.app.ready !== null) {
        const r = raw.app.ready;
        if (!isObj(r)) errs.push('app.ready: expected an object');
        else {
          keys(r, ['url', 'log_pattern', 'timeout_s'], 'app.ready', errs);
          const t = r.timeout_s === undefined ? 120 : r.timeout_s;
          if (!Number.isInteger(t) || t < 1 || t > 600) errs.push('app.ready.timeout_s: an integer 1-600');
          if ((r.url === undefined) === (r.log_pattern === undefined)) errs.push('app.ready: exactly one of "url" or "log_pattern"');
          else if (r.url !== undefined) { if (isLocalUrl(r.url)) cfg.app.ready = { url: r.url, timeout_s: t }; else errs.push('app.ready.url: http://localhost:<port> or http://127.0.0.1:<port>'); }
          else {
            let ok = typeof r.log_pattern === 'string' && r.log_pattern.length > 0 && r.log_pattern.length <= 200;
            if (ok) { try { new RegExp(r.log_pattern); } catch { ok = false; } }
            if (ok) cfg.app.ready = { log_pattern: r.log_pattern, timeout_s: t }; else errs.push('app.ready.log_pattern: a valid regular expression up to 200 characters');
          }
        }
      }
    }
  }
  if (raw.tests !== undefined) {
    if (!isObj(raw.tests)) errs.push('tests: expected an object');
    else {
      keys(raw.tests, ['setup', 'all', 'timeout_s'], 'tests', errs);
      for (const k of ['setup', 'all']) if (raw.tests[k] !== undefined && raw.tests[k] !== null) { const l = strList(raw.tests[k], `tests.${k}`, errs, 30); if (!l.length) errs.push(`tests.${k}: an argument list such as ["npm","test"]`); else cfg.tests[k] = l; }
      if (raw.tests.timeout_s !== undefined) { const t = raw.tests.timeout_s; if (Number.isInteger(t) && t >= 1 && t <= 3600) cfg.tests.timeout_s = t; else errs.push('tests.timeout_s: an integer 1-3600'); }
    }
  }
  if (raw.readiness !== undefined && raw.readiness !== null) {
    if (!isObj(raw.readiness)) errs.push('readiness: expected an object');
    else {
      keys(raw.readiness, ['min_level', 'max_age_days'], 'readiness', errs);
      const rd = { min_level: 3, max_age_days: 14 };
      const bounds = { min_level: [1, 4], max_age_days: [1, 90] };
      for (const [k, [lo, hi]] of Object.entries(bounds)) if (raw.readiness[k] !== undefined) { if (Number.isInteger(raw.readiness[k]) && raw.readiness[k] >= lo && raw.readiness[k] <= hi) rd[k] = raw.readiness[k]; else errs.push(`readiness.${k}: an integer ${lo}-${hi}`); }
      cfg.readiness = rd;
    }
  }
  if (raw.verification !== undefined) {
    const v = raw.verification;
    if (!isObj(v)) errs.push('verification: expected an object');
    else {
      keys(v, Object.keys(cfg.verification), 'verification', errs);
      if (v.required !== undefined) { if (typeof v.required === 'boolean') cfg.verification.required = v.required; else errs.push('verification.required: true or false'); }
      if (v.scenario_approval !== undefined) { if (['auto', 'human'].includes(v.scenario_approval)) cfg.verification.scenario_approval = v.scenario_approval; else errs.push('verification.scenario_approval: "auto" or "human"'); }
      const roles = (k, lo, hi, check, what) => {
        if (v[k] === undefined) return;
        if (!isObj(v[k])) { errs.push(`verification.${k}: expected an object with builder and author`); return; }
        keys(v[k], ['builder', 'author'], `verification.${k}`, errs);
        for (const r of ['builder', 'author']) if (v[k][r] !== undefined) { if (check(v[k][r], lo, hi)) cfg.verification[k][r] = v[k][r]; else errs.push(`verification.${k}.${r}: ${what(lo, hi)}`); }
      };
      const intIn = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
      roles('session_timeout_s', 60, 7200, intIn, (lo, hi) => `an integer ${lo}-${hi}`);
      roles('max_turns', 5, 1000, intIn, (lo, hi) => `an integer ${lo}-${hi}`);
      roles('model', 0, 0, (x) => x === null || (typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(x)), () => 'a model name or null');
      if (v.test_globs !== undefined) cfg.verification.test_globs = strList(v.test_globs, 'verification.test_globs', errs, 50);
    }
  }
  return { config: cfg, errors: errs };
}

// Glob for branch names and paths: ** crosses "/", * and ? do not. A trailing "/" means everything below that folder.
export function globToRegex(g) {
  let s = String(g).trim();
  if (s.endsWith('/')) s += '**';
  let re = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*') { if (s[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
export const matchesAny = (name, globs) => globs.some((g) => globToRegex(g).test(name));
export const isProtectedBranch = (branch, patterns) => matchesAny(branch, patterns);
export { FEATURE_ID };

// Host a git remote URL points at (https, ssh://, or scp-like git@host:path). null when it cannot be read.
export function remoteHost(url) {
  const u = String(url || '').trim();
  const scp = u.match(/^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)[^/].*$/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return scp[1].toLowerCase();
  try { return new URL(u).hostname.toLowerCase() || null; } catch { return null; }
}
export const isHttps = (url) => { try { return new URL(String(url).trim()).protocol === 'https:'; } catch { return false; } };
