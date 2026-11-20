// Hard-stop matrix (Phase 2, P2.2): each hard stop, the mechanism that really enforces it, and its proof. Zero dependencies.
// A proof is a test file under tests/validation/ that names the row id ({ kind: 'test', ref }) or isolation-probe routes
// ({ kind: 'probe', route, routes }) that must come back `denied` in the saved probe result ($FACTORY_HOME/probes/last.json,
// written by `probe.mjs --save`). Denying `gh` or `git push` by permission pattern alone is a prompt-layer rule; the real
// controls are no token, the network limit and branch protection.
import fs from 'node:fs';
import path from 'node:path';

// Every read route that does not depend on Spotlight indexing or Quick Look (those two are weak evidence, see probe.mjs).
const READ_ROUTES = ['fs.readFile', 'cat', 'cp', 'find', 'tar', 'node -e', 'python -c', 'git -C', 'hardlink', 'symlink'];
const probe = (routes) => Object.freeze({ kind: 'probe', route: routes[0], routes: Object.freeze([...routes]) });
const row = (id, name, mechanism, proof) => Object.freeze({ id, name, mechanism, proof: Object.freeze(proof) });

export const HARD_STOPS = Object.freeze([
  row('hs-secrets', 'builder reads secrets',
    'sandbox read deny on credential paths and FACTORY_HOME; allowlisted environment with no tokens; settings deny rules as a prompt-layer extra',
    probe(READ_ROUTES)),
  row('hs-network', 'builder reaches production hosts or databases',
    'sandbox network limited to registries and localhost for Bash; WebFetch and WebSearch denied; --strict-mcp-config with no MCP server for the builder',
    probe(['net bash'])),
  row('hs-destructive-data', 'destructive data operations',
    'only local seeded data is reachable (network rule); migrations are T3 and held by hold_paths',
    { kind: 'test', ref: 'delivery-orchestrator.test.mjs' }),
  row('hs-merge-gate', 'merge outside the gate; disabling CI or protection',
    'no GitHub token in the builder environment, the network rule, branch protection requiring factory/verified, CI-config changes held; denying gh and git push in settings is prompt-layer only',
    { kind: 'test', ref: 'factory-sessions.test.mjs' }),
  row('hs-delivery-config', 'changing autonomy or delivery config',
    '.product/delivery.json is held by deliver as a config path and is a G4 protected path, so a builder change is also held at merge',
    { kind: 'test', ref: 'factory-runcontrol-hardstops.test.mjs' }),
  row('hs-factory-state', 'editing run state, stop flags, local config, verdicts or usage records',
    'everything under FACTORY_HOME is write-denied to the builder (sandbox denyWrite and settings Edit/Write deny)',
    probe(['write stop/', 'write runs/', 'write usage/', 'write verdicts/', 'write config.json'])),
  row('hs-run-history', 'editing the run history',
    'driver-mode run records live in FACTORY_HOME/records/<repo-key>.jsonl, outside the repository and write-denied to the builder',
    probe(['write records/'])),
]);

// The fixed command an unproven row points to (references/safety.md, "Proving the hard stops").
export const PROBE_RUN = 'node probe.mjs --from <probe.json> --control <control.json> --save';

export const proofRoutes = (r) => (r.proof.kind === 'probe' ? [...(r.proof.routes || [r.proof.route])] : []);

// Probe-proof rows whose routes did not all come back `denied`. A missing or malformed result proves nothing: every probe row.
export function unprovenRows(result) {
  const routes = result && typeof result === 'object' && result.routes && typeof result.routes === 'object' && !Array.isArray(result.routes) ? result.routes : null;
  return HARD_STOPS.filter((r) => r.proof.kind === 'probe' && (!routes || proofRoutes(r).some((x) => routes[x] !== 'denied')));
}

// $FACTORY_HOME/probes/last.json, or null when absent, unreadable, corrupt, or reached through a symlink.
export function loadProbeResult(home) {
  const dir = path.join(home, 'probes'); const file = path.join(dir, 'last.json');
  try {
    if (!fs.lstatSync(dir).isDirectory() || !fs.lstatSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
