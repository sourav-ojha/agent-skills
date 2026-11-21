// Hard-stop matrix (Phase 2, P2.2): each hard stop, the mechanism that really enforces it, and its proof. Zero dependencies.
// A proof is a test file under tests/validation/ whose test title names the row id ({ kind: 'test', ref }) or isolation-probe
// routes ({ kind: 'probe', route, routes[, targets] }) that must come back `denied` in the saved probe result
// ($FACTORY_HOME/probes/last.json, written by `probe.mjs --save`). Denying `gh` or `git push` by permission pattern alone is a
// prompt-layer rule; the real controls are no token, the network limit and branch protection.
//
// A saved result is evidence only for what it probed:
//   - it is stale when builder_settings_sha256 differs from the current core/settings/builder.json (every probe row unproven);
//   - FACTORY_HOME routes count only when factory_home is the real FACTORY_HOME;
//   - hs-secrets needs one saved target per credential class (targets: ~/.ssh, ~/.aws, ~/.config/gh, ~/.netrc), each with every
//     read route denied: one probed directory never proves the row.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { factoryHome as defaultFactoryHome } from './factoryhome.mjs';

// Every read route that does not depend on Spotlight indexing or Quick Look (those two are weak evidence, see probe.mjs).
export const READ_ROUTES = Object.freeze(['fs.readFile', 'cat', 'cp', 'find', 'tar', 'node -e', 'python -c', 'git -C', 'hardlink', 'symlink']);
// Credential classes the secrets row must be probed against, relative to the home directory (.netrc is a file: --target-file).
export const SECRET_TARGETS = Object.freeze(['.ssh', '.aws', '.config/gh', '.netrc']);
export const BUILDER_SETTINGS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'settings', 'builder.json');

const probe = (routes, extra = {}) => Object.freeze({ kind: 'probe', route: routes[0], routes: Object.freeze([...routes]), ...extra });
const row = (id, name, mechanism, proof) => Object.freeze({ id, name, mechanism, proof: Object.freeze(proof) });

export const HARD_STOPS = Object.freeze([
  row('hs-secrets', 'builder reads credential files and directories covered by the saved probe targets',
    'sandbox read deny on credential paths and FACTORY_HOME; allowlisted environment with no tokens; settings deny rules as a prompt-layer extra. The probe is run once per credential class (~/.ssh, ~/.aws, ~/.config/gh, ~/.netrc); --save merges each target into the saved result, and the row is proven only when every class is a saved target with every read route denied',
    probe(READ_ROUTES, { targets: SECRET_TARGETS })),
  row('hs-network', 'builder reaches production hosts or databases',
    'sandbox network limited to registries and localhost for Bash (probe: net bash); the tool half (WebFetch and WebSearch denied, --strict-mcp-config with no MCP server) is a static check of builder.json and buildArgv, not a live probe',
    probe(['net bash'])),
  row('hs-destructive-data', 'destructive data operations',
    'only local seeded data is reachable (network rule); a migration is held only when the repository config lists its path in hold_paths (not by default)',
    { kind: 'test', ref: 'delivery-orchestrator.test.mjs' }),
  row('hs-merge-gate', 'merge outside the gate; disabling CI or protection',
    'no GitHub token in the builder environment, the network rule, branch protection requiring factory/verified, CI-config changes held; denying gh and git push in settings is prompt-layer only',
    { kind: 'test', ref: 'factory-sessions.test.mjs' }),
  row('hs-delivery-config', 'changing autonomy or delivery config',
    '.product/delivery.json is held by deliver as a config path and is a G4 protected path, so a builder change is also held at merge',
    { kind: 'test', ref: 'factory-runcontrol-hardstops.test.mjs' }),
  row('hs-factory-state', 'editing run state, stop flags, local config, verdicts or usage records',
    'everything under FACTORY_HOME is write-denied to the builder (sandbox denyWrite and settings Edit/Write deny); probed against the real FACTORY_HOME',
    probe(['write stop/', 'write runs/', 'write usage/', 'write verdicts/', 'write config.json'])),
  row('hs-run-history', 'editing the run history',
    'driver-mode run records live in FACTORY_HOME/records/<repo-key>.jsonl, outside the repository and write-denied to the builder; probed against the real FACTORY_HOME',
    probe(['write records/'])),
]);

// The fixed command an unproven row points to (references/safety.md, "Proving the hard stops").
export const PROBE_RUN = 'node probe.mjs --from <probe.json> --control <control.json> --save';

export const proofRoutes = (r) => (r.proof.kind === 'probe' ? [...(r.proof.routes || [r.proof.route])] : []);
export const builderSettingsSha = (file = BUILDER_SETTINGS) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && real(a) === real(b);
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const validResult = (r) => isObj(r) && isObj(r.routes) && Array.isArray(r.targets);

// Why a row is unproven by the saved result, or null when it is proven (test-proof rows: always null).
// opts: factoryHome (the real FACTORY_HOME), builderSha (sha256 of the current builder.json), home (the user's home directory).
export function whyUnproven(r, result, opts = {}) {
  if (r.proof.kind !== 'probe') return null;
  if (!validResult(result)) return 'no saved probe result';
  const builderSha = opts.builderSha ?? builderSettingsSha();
  if (result.builder_settings_sha256 !== builderSha) return 'the saved probe result is for other builder settings';
  if (r.proof.targets) {
    const home = opts.home ?? os.homedir();
    const ok = (cls) => result.targets.some((t) => isObj(t) && isObj(t.routes) && samePath(t.target, path.join(home, cls)) && proofRoutes(r).every((x) => t.routes[x] === 'denied'));
    const missing = r.proof.targets.filter((cls) => !ok(cls));
    return missing.length ? `targets not proven: ${missing.map((c) => `~/${c}`).join(', ')}` : null;
  }
  const routes = proofRoutes(r);
  if (routes.some((x) => x.startsWith('write ') && x !== 'write') && !samePath(result.factory_home, opts.factoryHome ?? defaultFactoryHome())) return 'the saved probe ran against another FACTORY_HOME';
  const bad = routes.filter((x) => result.routes[x] !== 'denied');
  return bad.length ? `not denied: ${bad.join(', ')}` : null;
}

// Probe-proof rows the saved result does not prove. A missing or malformed result proves nothing: every probe row.
export const unprovenRows = (result, opts = {}) => HARD_STOPS.filter((r) => whyUnproven(r, result, opts) !== null);

// $FACTORY_HOME/probes/last.json, or null when absent, unreadable, corrupt, or reached through a symlink.
export function loadProbeResult(home) {
  const dir = path.join(home, 'probes'); const file = path.join(dir, 'last.json');
  try {
    if (!fs.lstatSync(dir).isDirectory() || !fs.lstatSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
