// What the project file alone can prove about `factory run`'s start refusals (config edit --profile factory). No outside dependencies.
import { portOf } from './proc.mjs';
// The `why` text of the shared checks is the text startChecks (factory.mjs) refuses with; a test compares them.
const VERIFIED = 'factory/verified';
// The same port reading as verify.mjs (an explicit :80 is port 80).
const port = (u) => { try { return portOf(u); } catch { return null; } };

// The keys `config edit --profile factory` walks, in order (readiness is the opt-in switch for readiness.min_level).
export const FACTORY_KEYS = ['verification.required', 'readiness.min_level', 'local_checks', 'checks.required', 'app.setup', 'app.start', 'app.cli', 'app.stop', 'app.seed', 'app.base_url', 'app.ready', 'app.logs_dir', 'app.env_example', 'tests.setup', 'tests.all', 'tests.timeout_s', 'autonomy.level'];

// policy = the parsed config (parseConfig(doc).config) -> [{ id, why, fix }]
export function fileProblems(policy) {
  const p = policy; const out = [];
  const need = (bad, id, why, fix) => { if (bad) out.push({ id, why, fix }); };
  need(p.verification.required !== true, 'verification', 'verification.required is not true', 'set "verification": { "required": true } in .product/delivery.json and merge it to the base branch');
  need(!p.readiness || p.readiness.min_level < 4, 'readiness_level', 'the base config does not require readiness level 4', 'set "readiness": { "min_level": 4 } in .product/delivery.json on the base branch (deliver init then re-checks the stored result)');
  need(p.local_checks.length > 0, 'local_checks', 'local_checks are configured, and deliver built runs them outside the untrusted-code sandbox', 'run those checks in CI (checks.required) for factory runs, and set local_checks to []');
  need(p.checks.required.some((n) => n.toLowerCase() === VERIFIED), 'required_verified', `checks.required names ${VERIFIED}, which is posted only after CI passed`, `remove "${VERIFIED}" from checks.required (branch protection requires it at merge)`);
  const a = p.app || {};
  // A CLI-only project (app.cli set, app.start not) has no app to start: it needs no start command, base_url or ready.
  if (a.cli && !a.start) return out;
  need(!a.start, 'app_start', 'app.start is not set', 'set app.start (or app.cli for a command-line tool) to the command that starts the app, as an argument list such as ["npm","run","dev"]');
  const bp = a.base_url ? port(a.base_url) : null;
  need(!a.base_url || !bp, 'app_base_url', 'app.base_url is not set or has no port', 'set app.base_url to http://127.0.0.1:<port>, the address the app listens on');
  const rp = a.ready && a.ready.url ? port(a.ready.url) : null;
  need(!a.ready || (a.ready.url && (!bp || rp !== bp)), 'app_ready', a.ready ? 'app.ready.url is not on the port of app.base_url' : 'app.ready is not set', 'set app.ready to { "url": <app.base_url plus a path>, "timeout_s": 120 } (or a log_pattern) so verification knows when the app is up');
  return out;
}

// Informational only: not a refusal.
export function fileNotes(policy) {
  return policy.merge.mode === 'pr-only'
    ? [{ id: 'merge_mode', note: true, why: 'merge.mode is pr-only, factory run will open PRs but not merge', fix: 'set "autonomy": { "level": "L1" } if factory run should squash-merge when CI is green' }]
    : [];
}

// What the file cannot prove.
export function outsideFile() {
  return [
    { what: `branch protection on the base branch requires the ${VERIFIED} status`, command: 'GitHub: Settings > Branches (or a ruleset): require the "factory/verified" status check' },
    { what: 'a stored readiness level 4 result for the base branch', command: 'deliver readiness (in a checkout of the base branch)' },
    { what: 'approved scenarios for the features to run', command: 'factory scenarios (add --approve when verification.scenario_approval is human)' },
  ];
}
