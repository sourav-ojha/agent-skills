// growth-strategy skill structure: frontmatter, role registry, generated adapters, neutrality, independent install.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';
import { renderClaude, renderCodex } from '../../skills/growth-strategy/core/scripts/install-agents.mjs';

const DIR = path.join(REPO, 'skills/growth-strategy');
const lines = (p) => fs.readFileSync(p, 'utf8').split('\n').length;
const roles = () => JSON.parse(fs.readFileSync(path.join(DIR, 'core/roles/roles.json'), 'utf8')).roles;
const cfg = () => JSON.parse(fs.readFileSync(path.join(DIR, 'core/config.default.json'), 'utf8'));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('frontmatter, size caps, roles and links', () => {
  const skill = path.join(DIR, 'SKILL.md');
  const text = fs.readFileSync(skill, 'utf8');
  assert.match(text, /^---\nname: growth-strategy\n/);
  assert.match(text, /^description: .*Use when/m);
  assert.match(text, /^\s+version: "0\.1\.0"$/m);
  assert.ok(lines(skill) <= 200, `SKILL.md has ${lines(skill)} lines`);
  assert.deepEqual(roles().map((r) => r.name).sort(), ['distribution-researcher', 'growth-reviewer', 'product-seo-auditor', 'search-researcher']);
  for (const r of roles()) {
    assert.ok(['reasoning', 'standard', 'fast'].includes(r.tier));
    const f = path.join(DIR, 'core/roles', `${r.name}.md`);
    assert.ok(lines(f) <= 40, `${r.name}.md has ${lines(f)} lines`);
  }
  assert.equal(roles().find((r) => r.name === 'growth-reviewer').tier, 'reasoning');
  const links = [...text.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
  assert.ok(links.length >= 5);
  for (const l of links) assert.ok(fs.existsSync(path.join(DIR, l)), `broken link ${l}`);
});

test('SKILL.md documents every command, both gates and the protecting rules', () => {
  const t = fs.readFileSync(path.join(DIR, 'SKILL.md'), 'utf8');
  for (const c of ['init', 'audit', 'research', 'plan', 'review', 'full', 'refresh', 'status']) assert.match(t, new RegExp(`\\| \`${c}\``), c);
  for (const s of [/approve-baseline/, /gs decide/, /STOP/, /untrusted/, /Never fabricate/, /unknown/, /independent/, /background/, /No application code/i, /publish/]) assert.match(t, s);
});

test('generated adapters are in sync with roles and config; tools are scoped; model names are validated', () => {
  const r = spawnSync('node', [path.join(DIR, 'core/scripts/install-agents.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rev = roles().find((x) => x.name === 'growth-reviewer');
  const md = renderClaude(rev, cfg());
  assert.match(md, /^name: gs-growth-reviewer$/m);
  assert.match(md, /^tools: Read, Grep, Glob, WebSearch, WebFetch$/m);
  assert.match(md, /^model: opus$/m);
  assert.match(renderCodex(rev, cfg()), /model_reasoning_effort = "high"/);
  assert.doesNotMatch(renderClaude(roles().find((x) => x.name === 'search-researcher'), cfg()), /Bash|Edit|Write/);
  const bad = { models: { ...cfg().models, 'claude-code': { standard: 'x\ntools: Bash' } } };
  assert.throws(() => renderClaude(roles()[0], bad), /invalid model name/);
  assert.ok(fs.existsSync(path.join(DIR, 'agents/openai.yaml')));
});

test('agent-neutral core: no host tokens, no hardcoded model ids, no product-specific names', () => {
  const HOST = [/AskUserQuestion/, /\bTask tool\b/, /mcp__/, /\$ARGUMENTS/, /\.claude\//, /\.codex\//, /\.agents\//, /CLAUDE\.md/];
  const neutral = walk(DIR).filter((f) => { const r = path.relative(DIR, f); return !r.startsWith('adapters') && r !== 'agents/openai.yaml' && r !== path.join('core', 'scripts', 'install-agents.mjs') && /\.(md|json|mjs)$/.test(r); });
  assert.ok(neutral.length > 15);
  for (const f of neutral) {
    const t = fs.readFileSync(f, 'utf8');
    for (const re of HOST) assert.doesNotMatch(t, re, `${path.relative(DIR, f)} has ${re}`);
    if (!f.endsWith('config.default.json')) assert.doesNotMatch(t, /\b(claude-(opus|sonnet|haiku|fable)-[\w.-]+|gpt-\d[\w.-]*|gemini-[\w.-]+)\b/i, path.relative(DIR, f));
    assert.doesNotMatch(t, /sizetune|pixelpress/i, `${path.relative(DIR, f)} names a specific product`);
  }
});

test('the runlog copy is identical to the other skills (one shared contract)', () => {
  const read = (s) => fs.readFileSync(path.join(REPO, 'skills', s, 'core/scripts/lib/runlog.mjs'), 'utf8');
  assert.equal(read('growth-strategy'), read('experience-audit'));
});

test('installs and runs on its own: no imports outside the skill folder', () => {
  for (const f of walk(path.join(DIR, 'core')).filter((p) => p.endsWith('.mjs'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      assert.ok(target.startsWith(DIR + path.sep), `${path.relative(DIR, f)} imports ${m[1]} outside the skill`);
    }
  }
  const home = tmpDir('gs-install-');
  const copy = path.join(home, 'skills', 'growth-strategy');
  fs.cpSync(DIR, copy, { recursive: true });
  const proj = tmpDir('gs-solo-');
  const run = (args) => spawnSync('node', [path.join(copy, 'core/scripts/gs.mjs'), ...args, '--dir', proj], { encoding: 'utf8', env: { ...process.env, SKILL_RUNLOG: 'off' } });
  let r = run(['init']);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['growth.json', 'sources.json', 'keywords.json', 'items.json', 'seo-audit.md', 'monetization.md', '.gitignore']) assert.ok(fs.existsSync(path.join(proj, '.growth', f)), f);
  r = run(['validate']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = spawnSync('node', [path.join(copy, 'core/scripts/install-agents.mjs'), '--agent', 'all', '--scope', 'project', '--project-dir', proj], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readdirSync(path.join(proj, '.claude/agents')).length, 4);
  assert.equal(fs.readdirSync(path.join(proj, '.codex/agents')).length, 4);
});

test('templates carry every required section and the example records are valid', async () => {
  const arts = JSON.parse(fs.readFileSync(path.join(DIR, 'core/schemas/artifacts.json'), 'utf8'));
  for (const [file, secs] of Object.entries(arts.markdown)) {
    const t = fs.readFileSync(path.join(DIR, 'templates', file), 'utf8');
    for (const s of secs) assert.match(t, new RegExp(`^## ${s}$`, 'm'), `${file}: ${s}`);
  }
  assert.ok(arts.markdown['monetization.md'].includes('Consent and policy readiness'));
  const { validateSchema } = await import('../../skills/growth-strategy/core/scripts/lib/config.mjs');
  const schema = JSON.parse(fs.readFileSync(path.join(DIR, 'core/schemas/records.schema.json'), 'utf8'));
  for (const [tpl, def] of [['keyword.json', 'keyword'], ['item.json', 'item'], ['source.json', 'source'], ['review.json', 'review'], ['baseline.json', 'baseline']]) {
    const v = JSON.parse(fs.readFileSync(path.join(DIR, 'templates', tpl), 'utf8'));
    assert.deepEqual(validateSchema(v, { $ref: `#/$defs/${def}` }, '$', schema), [], tpl);
  }
});
