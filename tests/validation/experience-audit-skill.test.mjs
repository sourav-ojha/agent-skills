import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';
import { renderClaude } from '../../skills/experience-audit/core/scripts/install-agents.mjs';

const DIR = path.join(REPO, 'skills/experience-audit');
const lines = (p) => fs.readFileSync(p, 'utf8').split('\n').length;

test('size caps hold, every role has a file, every linked file exists', () => {
  const skill = path.join(DIR, 'SKILL.md');
  const text = fs.readFileSync(skill, 'utf8');
  assert.match(text, /^name: experience-audit$/m);
  assert.ok(lines(skill) <= 150, `SKILL.md has ${lines(skill)} lines`);
  const roles = JSON.parse(fs.readFileSync(path.join(DIR, 'core/roles/roles.json'), 'utf8')).roles;
  assert.deepEqual(roles.map((r) => r.name).sort(), ['a11y-checker', 'reviewer', 'seo-auditor', 'surveyor', 'visual-judge']);
  for (const r of roles) {
    const f = path.join(DIR, 'core/roles', `${r.name}.md`);
    assert.ok(fs.existsSync(f), `missing role file ${r.name}`);
    assert.ok(lines(f) <= 40, `${r.name}.md has ${lines(f)} lines`);
  }
  const links = [...text.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
  assert.ok(links.length >= 5);
  for (const l of links) assert.ok(fs.existsSync(path.join(DIR, l)), `broken link ${l}`);
});

test('the runlog copy is identical to the other skills (one shared contract)', () => {
  const read = (s) => fs.readFileSync(path.join(REPO, 'skills', s, 'core/scripts/lib/runlog.mjs'), 'utf8');
  assert.equal(read('experience-audit'), read('implementer'));
});

test('the collector is one read-only function expression that returns JSON-safe data', () => {
  const src = fs.readFileSync(path.join(DIR, 'core/probes/collect.js'), 'utf8');
  const fn = vm.runInNewContext(`(${src})`);
  assert.equal(typeof fn, 'function');
  // read-only: it must not assign to the page, submit, click or navigate
  assert.doesNotMatch(src, /\.click\(|\.submit\(|location\s*=|location\.(href|assign|replace)\s*=|\.remove\(|\.appendChild|\.innerHTML\s*=|localStorage|sessionStorage|fetch\(|XMLHttpRequest|document\.cookie/);
});

test('every check rule that can be emitted cites a source or a measurement, and the rules table in references/checks.md names them', () => {
  const checks = fs.readFileSync(path.join(DIR, 'references/checks.md'), 'utf8');
  for (const r of ['layout.overflow-x', 'layout.column-imbalance', 'layout.section-gap', 'a11y.target-size', 'a11y.image-alt', 'nav.footer-missing', 'nav.footer-sparse', 'nav.footer-ungrouped', 'nav.features-not-surfaced']) assert.match(checks, new RegExp(r.replace(/\./g, '\\.')), r);
});

test('native agent generation: browser roles inherit tools, read-only roles get no edit or shell, model names are validated', () => {
  const roles = JSON.parse(fs.readFileSync(path.join(DIR, 'core/roles/roles.json'), 'utf8')).roles;
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'core/config.default.json'), 'utf8'));
  const by = (n) => renderClaude(roles.find((r) => r.name === n), cfg);
  assert.doesNotMatch(by('surveyor'), /^tools:/m);
  assert.match(by('surveyor'), /^name: ea-surveyor$/m);
  assert.match(by('surveyor'), /model: haiku/);
  assert.match(by('reviewer'), /^tools: Read, Grep, Glob$/m);
  assert.doesNotMatch(by('reviewer'), /Bash|Edit|Write/);
  assert.match(by('reviewer'), /model: opus/);
  assert.throws(() => renderClaude(roles[0], { models: { 'claude-code': { fast: 'x\nmodel: evil' } } }), /invalid model name/);
  const d = tmpDir('ea-agents-');
  const r = spawnSync('node', [path.join(DIR, 'core/scripts/install-agents.mjs'), '--scope', 'project', '--project-dir', d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readdirSync(path.join(d, '.claude/agents')).length, 5);
  spawnSync('node', [path.join(DIR, 'core/scripts/install-agents.mjs'), '--scope', 'project', '--project-dir', d, '--remove']);
  assert.equal(fs.readdirSync(path.join(d, '.claude/agents')).length, 0);
});

test('the SKILL.md rules that protect the user are present', () => {
  const t = fs.readFileSync(path.join(DIR, 'SKILL.md'), 'utf8');
  for (const s of [/Read-only on the audited app/, /untrusted data/, /Never cross the decision gate/, /Say what you covered/, /No silent installs/, /capped at Medium/]) assert.match(t, s);
});

test('the template finding file is itself a valid finding (so the documented shape works)', async () => {
  const { checkFinding } = await import('../../skills/experience-audit/core/scripts/lib/audit.mjs');
  const [f] = JSON.parse(fs.readFileSync(path.join(DIR, 'templates/finding.json'), 'utf8'));
  assert.deepEqual(checkFinding(f, { cap: false }), []);
  const caps = JSON.parse(fs.readFileSync(path.join(DIR, 'templates/capabilities.json'), 'utf8'));
  assert.ok(Array.isArray(caps) && caps.every((c) => typeof c === 'string'));
});
