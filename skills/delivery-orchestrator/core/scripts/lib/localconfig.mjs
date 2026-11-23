// Per-user run-control config (<FACTORY_HOME>/config.json). Zero dependencies. Unknown keys are errors.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 64 * 1024;
export const KEYS = ['wait_for_reset', 'max_wait_h', 'max_wait_weekly_h', 'keep_awake', 'fallback_model', 'budgets'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const defaults = () => ({ wait_for_reset: false, max_wait_h: 6, max_wait_weekly_h: 0, keep_awake: true, fallback_model: null, budgets: { day_tokens: null } });

export function parseLocalConfig(raw, { classifierReal = false } = {}) {
  const config = defaults();
  const errors = [];
  if (!isObj(raw)) return { config, errors: ['config.json must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) errors.push(`unknown key "${k}"`);
  const bool = (k) => {
    if (raw[k] === undefined) return;
    if (typeof raw[k] !== 'boolean') errors.push(`${k} must be true or false`); else config[k] = raw[k];
  };
  const num = (k, max) => {
    if (raw[k] === undefined) return;
    const v = raw[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) errors.push(`${k} must be a number from 0 to ${max}`); else config[k] = v;
  };
  bool('wait_for_reset'); bool('keep_awake');
  num('max_wait_h', 12); num('max_wait_weekly_h', 168);
  if (raw.fallback_model !== undefined) {
    if (raw.fallback_model !== null && (typeof raw.fallback_model !== 'string' || !raw.fallback_model)) errors.push('fallback_model must be a non-empty string or null');
    else config.fallback_model = raw.fallback_model;
  }
  if (raw.budgets !== undefined) {
    if (!isObj(raw.budgets)) errors.push('budgets must be an object');
    else {
      for (const k of Object.keys(raw.budgets)) if (k !== 'day_tokens') errors.push(`unknown key "budgets.${k}"`);
      const d = raw.budgets.day_tokens;
      if (d !== undefined && d !== null) {
        if (!Number.isInteger(d) || d < 10000 || d > 1000000000) errors.push('budgets.day_tokens must be null or an integer from 10000 to 1000000000'); else config.budgets.day_tokens = d;
      }
    }
  }
  if (config.wait_for_reset && !classifierReal) errors.push('wait_for_reset: true is refused: the usage-limit classifier is fixtures only (not yet validated against a real limit event)');
  return { config, errors };
}

export function loadLocalConfig(home, opts) {
  const file = path.join(home, 'config.json');
  let fd;
  try {
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) {
      if (e.code === 'ENOENT') return parseLocalConfig({}, opts);
      return { config: defaults(), errors: [`cannot read ${file}: ${e.code === 'ELOOP' ? 'it is a symlink; refusing' : e.message}`] };
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return { config: defaults(), errors: [`cannot read ${file}: not a regular file or larger than 64 KiB`] };
    let doc;
    try { doc = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch (e) { return { config: defaults(), errors: [`${file} is not valid JSON: ${e.message}`] }; }
    const r = parseLocalConfig(doc, opts);
    return { config: r.config, errors: r.errors.map((m) => `${file}: ${m}`) };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
