#!/usr/bin/env node
// TEST HARNESS ONLY: runs factory.mjs main() with test seams. The factory CLI never sets any of these.
// FACTORY_TEST (JSON) configures it:
//   verify: { file: "src/{ID}.txt" }   stub verifyFeature: reads that file at the sha from the driver clone; "good" passes, "throw"
//                                       throws, anything else fails. It writes a real verdict file (verdict.mjs) and returns the real
//                                       symptom brief (verify.mjs symptomBrief), so the gate, postVerified and the brief are real.
//   killAfter: "<action>"              SIGKILLs this process right after that driver action finished (crash tests).
//   ciArgs: [...]                      extra deliver ci arguments (fast polling).
// The local bare origin is reached through a per-process url.<path>.insteadOf (GIT_CONFIG_* in this process's env), passed to the
// driver's network git as extraEnv, with the local file transport allowed (allowFile). Both are test-only seams.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'delivery-orchestrator', 'core', 'scripts');
const imp = (p) => import(pathToFileURL(path.join(SCRIPTS, p)).href);
const F = await imp('factory.mjs');
const V = await imp('lib/verdict.mjs');
const VF = await imp('lib/verify.mjs');
const { scenariosHash } = await imp('lib/scenarios.mjs');

const cfg = JSON.parse(process.env.FACTORY_TEST || '{}');
const extraEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)));

async function verifyStub({ repoKey, id, sha, scenarios, criteriaHash, git }) {
  const rel = String(cfg.verify?.file || 'src/{ID}.txt').replace('{ID}', id);
  const r = git('cat-file', '-p', `${sha}:${rel}`);
  const text = r.code === 0 ? r.out.trim() : '';
  if (text === 'throw') throw new Error('verification could not run (stub)');
  const status = text === 'good' ? 'pass' : 'fail';
  const results = scenarios.scenarios.map((s) => ({ id: s.id, covers: [...s.covers], status, flaky: false }));
  const doc = { feature: id, sha, scenarios_hash: scenariosHash(scenarios), criteria_hash: criteriaHash, results, verdict: status, at: new Date().toISOString() };
  V.writeVerdict(repoKey, doc);
  fs.appendFileSync(path.join(process.env.FACTORY_HOME, 'verify-calls.log'), `${id} ${sha} ${status}\n`);
  return { verdict: status, doc, brief: status === 'pass' ? [] : VF.symptomBrief(results, scenarios, scenarios.canary), reused: false };
}

const deps = {
  netGitOpts: { extraEnv, allowFile: true },
  verifyFeature: verifyStub,
  ciArgs: cfg.ciArgs || ['--interval', '0', '--grace', '0', '--timeout', '1'],
  afterAction: (act) => { if (cfg.killAfter && act === cfg.killAfter) process.kill(process.pid, 'SIGKILL'); },
};
process.exitCode = await F.main(process.argv.slice(2), deps);
