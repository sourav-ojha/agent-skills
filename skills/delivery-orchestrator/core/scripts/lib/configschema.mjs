// One entry per key the config parsers accept. The parsers (config.mjs, localconfig.mjs) stay the authority on validity;
// this module says what to show (allowed values, ranges, descriptions). tests/validation/config-wizard-schema.test.mjs
// fails when the two disagree. Zero dependencies.

// Walk order of the wizard.
export const GROUPS = ['repo', 'merge', 'ci', 'app', 'tests', 'budgets', 'verification', 'readiness', 'notes', 'local'];

const P = 'project';
const L = 'local';
const e = (path, group, type, rest) => ({ path, file: P, group, type, nullable: false, sensitive: false, ...rest });
const local = (path, type, rest) => ({ path, file: L, group: 'local', type, nullable: false, sensitive: false, ...rest });
const int = (path, group, min, max, dflt, rest) => e(path, group, 'int', { min, max, default: dflt, ...rest });
const argv = (path, what, why, example, readBy) => e(path, 'app', 'argv', { default: null, nullable: true, example, what, why, readBy });
const T = { run: ['deliver readiness', 'factory run'] };

export const SCHEMA = [
  // repo
  e('github.account', 'repo', 'text', { default: null, nullable: true, example: 'work-login', maxLen: 39, what: 'The gh login to use when several accounts are logged in.', why: 'Its token is used for every gh call, so the right account opens and merges the PRs. Empty uses the active gh account.', readBy: ['deliver init', 'factory run'] }),
  e('github.host', 'repo', 'text', { default: 'github.com', maxLen: 100, what: 'The GitHub host name.', why: 'Change it only for GitHub Enterprise. factory run requires it to match the origin remote host.', readBy: ['deliver init', 'factory run'], factory: 'must equal the origin host' }),
  e('base', 'repo', 'text', { default: null, nullable: true, example: 'develop', what: 'The branch every feature starts from and every PR targets.', why: 'Empty uses the repository default branch. If it matches a protected branch, PRs are opened but never merged.', readBy: ['deliver init', 'factory run'] }),
  e('branch_prefix', 'repo', 'text', { default: 'feat/', what: 'Prefix for feature branch names, lower-case and ending in a slash.', why: 'Keeps feature branches easy to find and to filter in CI. An empty string means no prefix.', readBy: ['deliver init'] }),
  e('features_dir', 'repo', 'relpath', { default: '.product/features', what: 'Folder inside the repository where FEATURE-NNN.md specs live.', why: 'The orchestrator reads feature specs from here. It must be a relative path with no "..".', readBy: ['deliver init', 'deliver intake'] }),

  // merge
  e('protected_branches', 'merge', 'list', { default: ['main', 'master', 'prod', 'production', 'release/*', 'release-*'], max: 50, sensitive: true, what: 'Branch globs this skill never merges into.', why: 'If base matches, PRs are opened and checked but left for a person. Only this file can change it, no flag overrides it.', readBy: ['deliver init', 'factory run'] }),
  e('merge.mode', 'merge', 'enum', { default: 'pr-only', sensitive: true, values: [{ v: 'pr-only', d: 'open PRs; nothing is merged' }, { v: 'squash', d: 'squash-merge when CI is green' }], alias: { to: 'autonomy.level', map: { 'pr-only': 'L0', squash: 'L1' } }, what: 'Older spelling of autonomy.level: pr-only is L0, squash is L1.', why: 'The wizard writes autonomy.level and removes this key, so the two cannot disagree. Writing both with different meanings is an error.', readBy: ['deliver init', 'factory run'] }),
  e('merge.allow_tier3', 'merge', 'bool', { default: false, sensitive: true, what: 'Also merge tier-3 work (auth, data, migrations, public API).', why: 'Tier-3 changes are the riskiest. With this off they are always left for a person to merge.', readBy: ['deliver init', 'factory run'] }),
  e('autonomy.level', 'merge', 'enum', { default: 'L0', sensitive: true, values: [{ v: 'L0', d: 'PRs only; nothing is merged' }, { v: 'L1', d: 'squash-merge when CI is green' }], what: 'How far the orchestrator may go without a person.', why: 'L1 merges to your base branch on its own. L2 and L3 are not available yet.', readBy: ['deliver init', 'factory run'], factory: 'must be L0 or L1; merging needs L1' }),
  e('hold_paths', 'merge', 'list', { default: [], max: 50, sensitive: true, what: 'Path globs whose change needs a person to review before merge.', why: 'A trailing slash means the whole folder. CI files, CODEOWNERS and this config file are always held.', readBy: ['deliver init', 'factory run'] }),

  // ci
  e('checks.required', 'ci', 'list', { default: [], max: 100, what: 'CI check names that must be reported and pass.', why: 'Empty uses the base branch required checks from branch protection. Names must match exactly.', readBy: ['deliver init', 'factory run'], factory: 'must not name factory/verified' }),
  e('checks.ignored', 'ci', 'list', { default: [], max: 100, sensitive: true, what: 'CI check globs that never fail or hold a feature.', why: 'For suites the project does not have or does not trust. GitHub branch protection can still block a merge.', readBy: ['deliver init', 'factory run'] }),
  e('checks.allow_without_ci', 'ci', 'bool', { default: false, sensitive: true, what: 'Allow merging on local evidence when no CI check exists.', why: 'Without CI there is no independent check on the change. Leave off unless the project truly has no CI.', readBy: ['deliver init', 'factory run'] }),
  e('local_checks', 'ci', 'local_checks', { default: [], max: 10, sensitive: true, children: ['name', 'command', 'timeout_s'], what: 'Commands the orchestrator runs itself before a PR is opened.', why: 'Each is a name, an argument list and a timeout of 1-3600 seconds (default 900). They run as you, outside the sandbox, so read them like a CI script.', readBy: ['deliver init'], factory: 'must be empty; run them in CI instead' }),
  int('limits.max_fix_rounds', 'ci', 0, 5, 2, { what: 'CI fix rounds allowed per feature.', why: 'After this many failed fix attempts the feature is held for a person.', readBy: ['deliver init', 'factory run'] }),
  int('limits.max_failures', 'ci', 1, 10, 2, { what: 'Blocked features in a row before the run stops.', why: 'Stops a run that keeps failing from burning more budget.', readBy: ['deliver init', 'factory run'] }),
  int('limits.ci_budget_s', 'ci', 1, 86400, 1800, { what: 'Total seconds to wait for CI per feature.', why: 'A feature whose CI does not finish in this time is held.', readBy: ['deliver init', 'factory run'] }),

  // app
  argv('app.setup', 'Command that prepares the app locally, as an argument list.', 'Run once before the app starts, for installs or migrations. An argument list, never a shell string; up to 30 arguments.', ['npm', 'install'], T.run),
  argv('app.start', 'Command that starts the app locally, as an argument list.', 'Verification starts the app with it. The app gets HOST=127.0.0.1 and PORT, and must listen on 127.0.0.1.', ['npm', 'run', 'dev'], T.run),
  argv('app.stop', 'Command that stops the app, as an argument list.', 'Used after verification. If empty the started process is signalled instead.', ['npm', 'run', 'stop'], T.run),
  e('app.base_url', 'app', 'url', { default: null, nullable: true, example: 'http://127.0.0.1:3000', what: 'Where the running app answers, on localhost or 127.0.0.1 only.', why: 'Must be http://localhost:<port> or http://127.0.0.1:<port>. Never https and never another host.', readBy: T.run, factory: 'needs a port' }),
  e('app.ready', 'app', 'ready', { default: null, nullable: true, example: { url: 'http://127.0.0.1:3000', timeout_s: 120 }, children: ['url', 'log_pattern', 'timeout_s'], what: 'How to tell the app is up: a local URL or a log pattern, plus a timeout.', why: 'Exactly one of url or log_pattern (a regex up to 200 characters). timeout_s is 1-600 and defaults to 120.', readBy: T.run, factory: 'a url must use the same port as app.base_url' }),
  e('app.logs_dir', 'app', 'relpath', { default: null, nullable: true, example: 'logs', what: 'Folder inside the repository where the app writes logs.', why: 'A relative path with no "..". Verification reads app logs from here.', readBy: T.run }),
  argv('app.seed', 'Command that seeds the app with data, as an argument list.', 'Run after the app is up so scenarios start from known data.', ['npm', 'run', 'seed'], T.run),
  e('app.env_example', 'app', 'relpath', { default: null, nullable: true, example: '.env.example', what: 'Path of the example environment file inside the repository.', why: 'A relative path with no "..". Used to tell the app which variables it needs.', readBy: T.run }),

  // tests
  { ...argv('tests.setup', 'Command that prepares the test suite, as an argument list.', 'Run before the full suite, for installs or fixtures. An argument list; up to 30 arguments.', ['npm', 'ci'], T.run), group: 'tests' },
  { ...argv('tests.all', 'Command that runs the full test suite, as an argument list.', 'Readiness runs this to see whether the suite passes. An argument list; up to 30 arguments.', ['npm', 'test'], T.run), group: 'tests' },
  int('tests.timeout_s', 'tests', 1, 3600, 900, { what: 'Time limit in seconds for the full test suite.', why: 'A suite that runs longer is stopped and counted as failed.', readBy: T.run }),
  e('verification.test_globs', 'tests', 'list', { default: [], max: 50, what: 'Path globs that identify test files.', why: 'Verification uses them to tell test files from product code when checking a change.', readBy: ['factory run'] }),

  // budgets
  int('budgets.feature.tokens', 'budgets', 10000, 1000000000, 3000000, { sensitive: true, what: 'Token cap per feature for factory run.', why: 'A runaway guard. Tokens counted are input, output and cache creation. Raising it lets a feature spend more.', readBy: ['factory run'] }),
  int('budgets.feature.turns', 'budgets', 10, 5000, 400, { sensitive: true, what: 'Agent turn cap per feature for factory run.', why: 'A runaway guard. Raising it lets a feature run longer before it is stopped.', readBy: ['factory run'] }),

  // verification
  e('verification.required', 'verification', 'bool', { default: false, sensitive: true, what: 'Whether a feature must pass the verification gate.', why: 'With it on, a feature is only done when independent scenarios pass. Turning it off removes that gate.', readBy: ['deliver verify', 'factory run'], factory: 'must be true' }),
  e('verification.scenario_approval', 'verification', 'enum', { default: 'auto', sensitive: true, values: [{ v: 'auto', d: 'scenarios are accepted without a person' }, { v: 'human', d: 'a person approves the scenarios' }], what: 'Who approves the verification scenarios.', why: 'auto lets the run continue unattended. human holds the feature until a person approves.', readBy: ['deliver verify', 'factory run'] }),
  int('verification.session_timeout_s.builder', 'verification', 60, 7200, 1800, { what: 'Time limit in seconds for one builder agent session.', why: 'A session that runs longer is stopped.', readBy: ['factory run'] }),
  int('verification.session_timeout_s.author', 'verification', 60, 7200, 900, { what: 'Time limit in seconds for one scenario author session.', why: 'A session that runs longer is stopped.', readBy: ['factory run'] }),
  int('verification.max_turns.builder', 'verification', 5, 1000, 200, { what: 'Turn limit for one builder agent session.', why: 'Stops a session that loops without finishing.', readBy: ['factory run'] }),
  int('verification.max_turns.author', 'verification', 5, 1000, 40, { what: 'Turn limit for one scenario author session.', why: 'Stops a session that loops without finishing.', readBy: ['factory run'] }),
  e('verification.model.builder', 'verification', 'text', { default: null, nullable: true, example: 'claude-sonnet-4-5', maxLen: 80, what: 'Model name for the builder session, or empty for the default.', why: 'Letters, digits and . _ : - only, up to 80 characters.', readBy: ['factory run'] }),
  e('verification.model.author', 'verification', 'text', { default: null, nullable: true, example: 'claude-sonnet-4-5', maxLen: 80, what: 'Model name for the scenario author session, or empty for the default.', why: 'Letters, digits and . _ : - only, up to 80 characters.', readBy: ['factory run'] }),

  // readiness
  e('readiness', 'readiness', 'object-null', { default: null, nullable: true, example: {}, what: 'Opt-in switch for readiness checks; absent means the project has not opted in.', why: 'Present, even as an empty object, turns readiness checks on with the defaults below.', readBy: ['deliver readiness', 'factory run'] }),
  int('readiness.min_level', 'readiness', 1, 4, 3, { what: 'Lowest acceptable readiness level.', why: 'A project below this level is not ready for unattended runs. Applies when readiness is present.', readBy: ['deliver readiness', 'factory run'], factory: 'must be 4' }),
  int('readiness.max_age_days', 'readiness', 1, 90, 14, { what: 'How many days old a readiness result may be.', why: 'An older result is treated as missing and the check is run again. Applies when readiness is present.', readBy: ['deliver readiness', 'factory run'] }),

  // notes
  e('implementer_notes', 'notes', 'text', { default: '', maxLen: 500, what: 'Text shown to the implementer for every feature.', why: 'For facts the implementer cannot see, such as which kinds of tests exist. Up to 500 characters.', readBy: ['deliver init', 'implementer'] }),

  // local (~/.factory/config.json)
  local('wait_for_reset', 'bool', { default: false, sensitive: false, what: 'Wait for a usage limit to reset instead of stopping.', why: 'Currently refused: the limit detector is only tested on fixtures, so true is an error.', readBy: ['factory run'] }),
  local('max_wait_h', 'int', { min: 0, max: 12, default: 6, what: 'Longest wait in hours for a usage limit to reset.', why: 'A longer reset stops the run instead of waiting.', readBy: ['factory run'] }),
  local('max_wait_weekly_h', 'int', { min: 0, max: 168, default: 0, what: 'Longest wait in hours for a weekly usage limit to reset.', why: '0 means a weekly limit always stops the run.', readBy: ['factory run'] }),
  local('keep_awake', 'bool', { default: true, what: 'Keep the machine awake while a run is going.', why: 'A sleeping laptop pauses the run and can break running sessions.', readBy: ['factory run'] }),
  local('fallback_model', 'text', { default: null, nullable: true, example: 'claude-sonnet-4-5', what: 'Model to switch to when the main model is out of quota.', why: 'Empty means the run stops instead of switching.', readBy: ['factory run'] }),
  local('budgets.day_tokens', 'int', { min: 10000, max: 1000000000, default: null, nullable: true, example: 20000000, sensitive: true, what: 'Token cap per day across all runs on this machine.', why: 'Empty means no daily cap. Raising it lets runs spend more in a day.', readBy: ['factory run'] }),
];

export const entry = (path, file = P) => SCHEMA.find((x) => x.file === file && x.path === path);
export const keysOf = (file = P) => SCHEMA.filter((x) => x.file === file).map((x) => x.path);

const distance = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};

// The n valid keys closest to a mistyped one (edit distance, ties in schema order).
export function nearest(path, file = P, n = 3) {
  return keysOf(file).map((k, i) => ({ k, i, d: distance(String(path), k) })).sort((a, b) => a.d - b.d || a.i - b.i).slice(0, n).map((x) => x.k);
}

const show = (v) => (v === null ? 'null (unset)' : JSON.stringify(v));
const range = (e) => (e.type === 'int' ? `an integer, ${e.min} to ${e.max}` : null);
const TYPES = { bool: 'true or false', enum: 'one of the values below', text: 'text', relpath: 'a relative path inside the repository', url: 'a local http URL', argv: 'an argument list (array of strings)', list: 'a list of strings', local_checks: 'a list of { name, command, timeout_s }', ready: '{ url or log_pattern, timeout_s }', 'object-null': 'an object, or absent' };
const typeText = (e) => range(e) || (e.maxLen ? `${TYPES[e.type]}, up to ${e.maxLen} characters` : e.max && e.type === 'list' ? `${TYPES[e.type]}, up to ${e.max} items` : TYPES[e.type] || e.type);

// Plain-text description of one key, for `config explain <key>`.
export function renderExplain(e) {
  const lines = [e.path + (e.sensitive ? '   SENSITIVE' : ''), `  ${e.what}`, `  type:    ${typeText(e)}`, `  default: ${show(e.default)}`];
  if (e.values) { lines.push('  values:'); for (const x of e.values) lines.push(`    ${x.v}   ${x.d}`); }
  if (e.alias) lines.push(`  alias:   older spelling of ${e.alias.to}`);
  if (e.nullable) lines.push('  null:    allowed (unset)');
  if (e.example !== undefined) lines.push(`  example: ${JSON.stringify(e.example)}`);
  lines.push(`  why:     ${e.why}`, `  read by: ${e.readBy.join(', ')}`);
  if (e.factory) lines.push(`  factory run: ${e.factory}`);
  if (e.sensitive) lines.push('  SENSITIVE: loosening it needs a person at a terminal; set refuses without one.');
  return lines.join('\n');
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
const dflt = (e) => (e.default === null ? '`null`' : `\`${JSON.stringify(e.default)}\``);

// One markdown table per group; the text between the markers in references/config.md.
export function renderDocs(file = P) {
  const out = [];
  for (const g of GROUPS) {
    const rows = SCHEMA.filter((x) => x.file === file && x.group === g);
    if (!rows.length) continue;
    out.push(`**${g}**`, '', '| Key | Meaning | Default |', '|---|---|---|');
    for (const e of rows) {
      const vals = e.values ? ` Values: ${e.values.map((x) => `\`${x.v}\` (${x.d})`).join(', ')}.` : '';
      const note = e.factory ? ` factory run: ${e.factory}.` : '';
      out.push(`| \`${e.path}\`${e.sensitive ? ' (sensitive)' : ''} | ${cell(`${e.what} ${e.why}${vals}${note}`)} | ${dflt(e)} |`);
    }
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '');
}

// One line per key, grouped, for `config explain --list`.
export function renderList(file = P) {
  const out = [];
  for (const g of GROUPS) {
    const rows = SCHEMA.filter((x) => x.file === file && x.group === g);
    if (!rows.length) continue;
    out.push(`${g}`, ...rows.map((e) => `  ${e.path}${e.sensitive ? ' *' : ''}   ${e.what}`));
  }
  return out.join('\n');
}
