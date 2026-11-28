#!/usr/bin/env node
// TEST HARNESS ONLY: runs factory.mjs main() with test seams. The factory CLI never sets any of these.
// FACTORY_TEST (JSON) configures it:
//   verify: { file: "src/{ID}.txt" }   stub verifyFeature: reads that file at the sha from the driver clone; "good" passes, "throw"
//                                       throws, anything else fails. It writes a real verdict file (verdict.mjs) and returns the real
//                                       symptom brief (verify.mjs symptomBrief), so the gate, postVerified and the brief are real.
//                                       delayMs: the stub first waits that long (a verification in progress, for kill tests).
//   killAfter: "<action>"              SIGKILLs this process right after that driver action finished (crash tests).
//   ciArgs: [...]                      extra deliver ci arguments (fast polling).
//   now: <ms>                          a fake clock (deps.clock) starting at that time; sleep(ms) advances it without waiting.
//                                       Every sleep is logged to FACTORY_HOME/sleeps.log (one ms value per line).
//   jump: { at: N, ms: M }             the Nth sleep (1-based) also moves the fake clock M ms forward (a laptop sleep or clock jump).
//   frozen: true                       sleep never advances the fake clock (a clock that never reaches the wait's end).
//   classifierReal: true               treat the usage-limit classifier as validated (lets config.json turn wait_for_reset on).
//   timeoutS: <s>                      overrides every builder session's timeout (timeout tests; the policy minimum is 60 s).
// Always: notifications are recorded to FACTORY_HOME/notify.log ("<event> <count>") instead of osascript; keep-awake is recorded to
// FACTORY_HOME/awake.log (its argv) instead of spawning caffeinate, with the platform reported as darwin.
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
  if (Number.isFinite(cfg.verify?.delayMs)) await new Promise((r) => { setTimeout(r, cfg.verify.delayMs); });
  const rel = String(cfg.verify?.file || 'src/{ID}.txt').replace('{ID}', id);
  const r = git('cat-file', '-p', `${sha}:${rel}`);
  const text = r.code === 0 ? r.out.trim() : '';
  if (text === 'throw') throw new Error('verification could not run (stub)');
  const status = text === 'good' ? 'pass' : 'fail';
  const results = scenarios.scenarios.map((s) => ({ id: s.id, covers: [...s.covers], status, flaky: false }));
  const doc = { feature: id, sha, scenarios_hash: scenariosHash(scenarios), criteria_hash: criteriaHash, results, verdict: status, at: new Date().toISOString() };
  V.writeVerdict(repoKey, doc);
  fs.appendFileSync(path.join(process.env.FACTORY_HOME, 'verify-calls.log'), `${id} ${sha} ${status}\n`);
  // verify.family: a cli set's failing scenarios report that failed-family word (the real verifier returns it as `families`, never stored).
  const families = cfg.verify?.family && status !== 'pass' ? Object.fromEntries(results.map((r) => [r.id, cfg.verify.family])) : null;
  return { verdict: status, doc, brief: status === 'pass' ? [] : VF.symptomBrief(results.map((r) => ({ ...r, failed: families?.[r.id] })), scenarios, scenarios.canary), reused: false, ...(families ? { families } : {}) };
}

let fakeNow = Number.isFinite(cfg.now) ? cfg.now : null;
let sleeps = 0;
const fhLog = (name, line) => fs.appendFileSync(path.join(process.env.FACTORY_HOME, name), `${line}\n`);
const fakeSleep = async (ms) => {
  sleeps++;
  fhLog('sleeps.log', ms);
  if (!cfg.frozen) fakeNow += ms;
  if (cfg.jump && cfg.jump.at === sleeps) fakeNow += cfg.jump.ms;
};
const S = await imp('lib/sessions.mjs');
const deps = {
  ...(fakeNow !== null ? { clock: { now: () => fakeNow, sleep: fakeSleep } } : {}),
  ...(cfg.classifierReal ? { classifierReal: true } : {}),
  ...(Number.isFinite(cfg.timeoutS) ? { runSession: (o) => S.runSession(o.role === 'builder' ? { ...o, timeoutS: cfg.timeoutS, killGraceMs: 200 } : o) } : {}),
  notify: (event, { count } = {}) => { fhLog('notify.log', `${event} ${count}`); return true; },
  keepAwake: (argv) => { fhLog('awake.log', argv.join(' ')); return { kill: () => fhLog('awake.log', 'killed') }; },
  platform: 'darwin',
  netGitOpts: { extraEnv, allowFile: true },
  verifyFeature: verifyStub,
  ciArgs: cfg.ciArgs || ['--interval', '0', '--grace', '0', '--timeout', '1'],
  afterAction: (act) => { if (cfg.killAfter && act === cfg.killAfter) process.kill(process.pid, 'SIGKILL'); },
};
process.exitCode = await F.main(process.argv.slice(2), deps);
