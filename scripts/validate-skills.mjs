#!/usr/bin/env node
// Repository validator: Agent Skills compatibility, structure, reference integrity,
// template completeness, schema validity, adapter sync, portability, install docs.
// usage: node scripts/validate-skills.mjs [skillsRoot] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lockErrors } from './lib/skillsync.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
const root = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(REPO, 'skills'));

const SPEC_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const CLAUDE_KEYS = ['when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable', 'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell'];
// Host-specific tokens that must not leak into the agent-neutral methodology.
const HOST_TOKENS = [/AskUserQuestion/, /\bTask tool\b/, /mcp__/, /\$ARGUMENTS/, /\$\{CLAUDE_/, /\.claude\//, /\.codex\//, /\.agents\//, /\/plugin\b/, /CLAUDE\.md/];
// Exemption from the host-token check ONLY, for files whose subject is the Claude Code runtime itself: the factory's
// `claude -p` session runner and the settings files it passes to Claude Code (they must name its config dir layout, e.g.
// the memory file). Narrowest list: exact skill-relative paths, nothing else in those skills is exempt.
const HOST_TOKEN_EXEMPT = { 'delivery-orchestrator': ['core/scripts/lib/sessions.mjs', 'core/settings/builder.json', 'core/settings/author.json'] };
const SECRET_PATTERNS = [/AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{30,}/, /sk-[A-Za-z0-9]{32,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

// Imported (first-party legacy) and vendored (third-party) skills get the spec-level checks only: they are not written to this repo's
// host-neutral rules, and vendored content must stay identical to upstream. The lock records which are which.
const LOCK = safeJsonSync(path.join(REPO, 'skills.lock.json'));
const relaxed = (name) => ['imported', 'vendored'].includes(LOCK?.skills?.[name]?.origin);
function safeJsonSync(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

class SkipSync extends Error {}
const results = [];
const safeJson = (p, S) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
function add(skill, level, msg) { results.push({ skill, level, msg }); }

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.DS_Store') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

async function validateSkill(dirName) {
  const dir = path.join(root, dirName);
  const S = (level, msg) => add(dirName, level, msg);
  const skillMd = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return S('error', 'missing SKILL.md');
  const { splitFrontmatter } = await import(pathToFileURL(path.join(dir, 'core/scripts/lib/fm.mjs')).href).catch(() => import(pathToFileURL(path.join(REPO, 'skills/product-intelligence/core/scripts/lib/fm.mjs')).href));
  const text = fs.readFileSync(skillMd, 'utf8');
  const { data, error, hasFrontmatter } = splitFrontmatter(text);
  if (!hasFrontmatter) return S('error', 'SKILL.md has no YAML frontmatter');
  if (error) return S('error', `frontmatter: ${error}`);

  // --- Agent Skills spec ---
  if (!data.name) S('error', 'frontmatter: name is required');
  else {
    if (data.name !== dirName) S('error', `name "${data.name}" must match directory "${dirName}"`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.name) || data.name.length > 64) S('error', `name "${data.name}" must be lowercase alphanumeric/hyphens (no leading/trailing/double hyphen), max 64`);
  }
  if (!data.description) S('error', 'frontmatter: description is required');
  else {
    if (data.description.length > 1024) S('error', `description is ${data.description.length} chars (max 1024)`);
    if (!/\b(use when|when )/i.test(data.description)) S('warn', 'description should say when to use the skill');
  }
  if (data.compatibility && data.compatibility.length > 500) S('error', 'compatibility exceeds 500 chars');
  if (data.metadata && typeof data.metadata === 'object') {
    for (const [k, v] of Object.entries(data.metadata)) if (typeof v !== 'string') S('error', `metadata.${k} must be a string`);
  }
  for (const k of Object.keys(data)) if (![...SPEC_KEYS, ...CLAUDE_KEYS].includes(k)) S('warn', `unknown frontmatter key "${k}" (not in Agent Skills spec or Claude Code docs)`);
  const lines = text.split('\n').length;
  if (lines > 500) S('error', `SKILL.md is ${lines} lines (keep under 500; move detail to references/)`);
  if (!data.license && !relaxed(dirName)) S('warn', 'no license declared');

  if (relaxed(dirName)) {
    for (const f of walk(dir)) {
      if (/\.(png|jpg|gif|ico|zip)$/.test(f)) continue;
      const t = fs.readFileSync(f, 'utf8');
      for (const re of SECRET_PATTERNS) if (re.test(t)) S('error', `${path.relative(dir, f)}: looks like a secret (${re})`);
    }
    return;
  }

  // --- Required files ---
  const need = [
    'references/research-methodology.md', 'references/competitor-analysis.md', 'references/evidence-standards.md',
    'references/opportunity-prioritization.md', 'references/feature-specification.md', 'references/artifact-contracts.md', 'references/orchestration.md',
    'templates/product-understanding.md', 'templates/competitor-profile.md', 'templates/opportunity.md', 'templates/feature-specification.md',
    'core/config.default.json', 'core/schemas/artifacts.json', 'core/schemas/lifecycle.json', 'core/schemas/config.schema.json',
    'core/scripts/pi.mjs', 'core/validators/validate-artifacts.mjs', 'core/roles/roles.json', 'agents/openai.yaml',
    'adapters/claude-code/README.md', 'adapters/codex/README.md',
  ];
  if (dirName === 'skill-insights') for (const f of ['references/metrics.md', 'core/scripts/si.mjs', 'core/scripts/lib/transcripts.mjs', 'core/scripts/lib/analyze.mjs', 'core/scripts/lib/runs.mjs', 'core/scripts/lib/agy.mjs', 'core/scripts/lib/proto.mjs', 'core/scripts/lib/agyio.mjs', 'adapters/claude-code/README.md', 'adapters/antigravity/README.md']) if (!fs.existsSync(path.join(dir, f))) S('error', `required file missing: ${f}`);
  if (dirName === 'delivery-orchestrator') for (const f of ['references/states.md', 'references/safety.md', 'references/config.md', 'templates/delivery.json', 'core/scripts/deliver.mjs', 'core/scripts/lib/queue.mjs', 'core/scripts/lib/config.mjs', 'core/scripts/lib/runlog.mjs', 'references/readiness.md', 'core/scripts/lib/readiness.mjs', 'core/scripts/lib/proc.mjs', 'core/scripts/lib/runrecord.mjs', 'core/scripts/lib/limits.mjs', 'core/scripts/lib/factoryhome.mjs', 'adapters/claude-code/README.md',
    // factory phase 1a: driver, its libraries, session settings and prompts, references
    'core/scripts/factory.mjs', 'core/scripts/lib/criteria.mjs', 'core/scripts/lib/scenarios.mjs', 'core/scripts/lib/antigaming.mjs',
    'core/scripts/lib/gitsafe.mjs', 'core/scripts/lib/sandbox.mjs', 'core/scripts/lib/sessions.mjs', 'core/scripts/lib/verdict.mjs',
    'core/scripts/lib/apicheck.mjs', 'core/scripts/lib/verify.mjs', 'core/scripts/lib/lock.mjs', 'core/scripts/lib/driver.mjs',
    'core/settings/builder.json', 'core/settings/author.json', 'core/prompts/scenario-author.md', 'core/prompts/continue-brief.md',
    'references/verification.md', 'references/factory-driver.md', 'references/run-control.md']) if (!fs.existsSync(path.join(dir, f))) S('error', `required file missing: ${f}`);
  if (dirName === 'experience-audit') for (const f of ['references/audit-method.md', 'references/checks.md', 'references/evidence-and-severity.md', 'templates/finding.json', 'core/config.default.json', 'core/probes/collect.js', 'core/scripts/ea.mjs', 'core/scripts/lib/checks.mjs', 'core/scripts/lib/audit.mjs', 'core/scripts/lib/runlog.mjs', 'core/scripts/install-agents.mjs', 'core/roles/roles.json', 'adapters/claude-code/README.md']) if (!fs.existsSync(path.join(dir, f))) S('error', `required file missing: ${f}`);
  if (dirName === 'growth-strategy') for (const f of ['references/research-standards.md', 'references/workflow.md', 'references/coverage.md', 'references/integrations.md', 'references/artifacts.md', 'templates/baseline.json', 'templates/keyword.json', 'templates/item.json', 'templates/source.json', 'templates/review.json', 'core/config.default.json', 'core/schemas/records.schema.json', 'core/schemas/artifacts.json', 'core/schemas/config.schema.json', 'core/scripts/gs.mjs', 'core/scripts/lib/state.mjs', 'core/scripts/lib/evidence.mjs', 'core/scripts/lib/config.mjs', 'core/scripts/lib/runlog.mjs', 'core/scripts/install-agents.mjs', 'core/roles/roles.json', 'agents/openai.yaml', 'adapters/claude-code/README.md', 'adapters/codex/README.md']) if (!fs.existsSync(path.join(dir, f))) S('error', `required file missing: ${f}`);
  if (dirName === 'feature-intake') for (const f of ['references/intake-procedure.md', 'references/writing-criteria.md', 'references/codebase-analysis.md', 'references/risk-marking.md', 'templates/feature-specification.md', 'core/scripts/fi.mjs', 'core/scripts/lib/spec.mjs', 'core/scripts/lib/criteria.mjs', 'core/scripts/lib/runlog.mjs', 'adapters/claude-code/README.md']) if (!fs.existsSync(path.join(dir, f))) S('error', `required file missing: ${f}`);
  if (dirName === 'implementer') for (const f of ['references/triage.md', 'references/tdd-and-acceptance.md', 'templates/mini-spec.md', 'core/config.default.json', 'core/scripts/impl.mjs', 'core/scripts/lib/ledger.mjs', 'core/scripts/install-agents.mjs', 'core/roles/roles.json', 'adapters/claude-code/README.md']) if (!fs.existsSync(path.join(dir, f))) S('error', `required file missing: ${f}`);
  if (dirName === 'product-intelligence') for (const f of need) if (!fs.existsSync(path.join(dir, f))) S('error', `required file missing: ${f}`);

  const files = walk(dir);
  const rel = (p) => path.relative(dir, p).split(path.sep).join('/');

  // --- JSON validity ---
  for (const f of files.filter((p) => p.endsWith('.json'))) {
    try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { S('error', `${rel(f)}: invalid JSON (${e.message})`); }
  }

  // --- Reference integrity (links and skill-relative backtick paths) ---
  const mdFiles = files.filter((p) => p.endsWith('.md') && !rel(p).startsWith('adapters/'));
  const adapterMd = files.filter((p) => p.endsWith('.md') && rel(p).startsWith('adapters/') && p.endsWith('README.md'));
  for (const f of [...mdFiles, ...adapterMd]) {
    const t = fs.readFileSync(f, 'utf8');
    const base = path.dirname(f);
    for (const m of t.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      if (!fs.existsSync(path.resolve(base, target))) S('error', `${rel(f)}: broken link "${target}"`);
    }
    for (const m of t.matchAll(/`((?:core|references|templates|adapters)\/[A-Za-z0-9_./-]+)`/g)) {
      const p = m[1].replace(/\/$/, '');
      if (!fs.existsSync(path.join(dir, p))) S('error', `${rel(f)}: referenced path "${m[1]}" does not exist`);
    }
  }

  // --- Roles <-> adapters sync ---
  if (fs.existsSync(path.join(dir, 'core/roles/roles.json'))) {
    const roles = JSON.parse(fs.readFileSync(path.join(dir, 'core/roles/roles.json'), 'utf8')).roles;
    for (const r of roles) {
      if (!fs.existsSync(path.join(dir, 'core/roles', `${r.name}.md`))) S('error', `role "${r.name}" has no core/roles/${r.name}.md`);
      if (!['reasoning', 'standard', 'fast'].includes(r.tier)) S('error', `role "${r.name}" has invalid tier "${r.tier}"`);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.name)) S('error', `role name "${r.name}" invalid`);
    }
    try {
      const inst = await import(pathToFileURL(path.join(dir, 'core/scripts/install-agents.mjs')).href);
      if (typeof inst.renderAll !== 'function') throw new SkipSync(); // skills that generate agents on demand only (no committed adapter copies)
      const { loadConfig } = await import(pathToFileURL(path.join(dir, 'core/scripts/lib/config.mjs')).href);
      const { config } = loadConfig(null);
      for (const f of inst.renderAll(config)) {
        const p = path.join(dir, 'adapters', f.platform, 'agents', f.file);
        if (!fs.existsSync(p)) S('error', `adapter file missing: adapters/${f.platform}/agents/${f.file}`);
        else if (fs.readFileSync(p, 'utf8') !== f.content) S('error', `adapter file out of sync with roles/config: adapters/${f.platform}/agents/${f.file} (run install-agents.mjs --generate-defaults)`);
      }
    } catch (e) { if (!(e instanceof SkipSync)) S('error', `adapter sync check failed: ${e.message}`); }
  }

  // --- Cross-agent portability: neutral core ---
  const neutral = files.filter((p) => {
    const r = rel(p);
    if (r.startsWith('adapters/') || r === 'agents/openai.yaml' || r === 'core/scripts/install-agents.mjs') return false;
    return /\.(md|json|mjs)$/.test(r);
  });
  for (const f of neutral) {
    if ((Object.hasOwn(HOST_TOKEN_EXEMPT, dirName) ? HOST_TOKEN_EXEMPT[dirName] : []).includes(rel(f))) continue;
    const t = fs.readFileSync(f, 'utf8');
    for (const re of HOST_TOKENS) if (re.test(t)) S('error', `${rel(f)}: host-specific token ${re} in agent-neutral content (move to adapters/)`);
  }

  // --- Template completeness ---
  if (dirName === 'product-intelligence') {
    const arts = safeJson(path.join(dir, 'core/schemas/artifacts.json'));
    const lc = safeJson(path.join(dir, 'core/schemas/lifecycle.json'));
    const cfg = safeJson(path.join(dir, 'core/config.default.json'));
    if (!arts || !lc || !cfg) return S('error', 'core schemas/config unreadable; skipping dependent checks');
    const heads = (f) => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^##\s+(?:\d+\.\s*)?(.+?)\s*$/gm)].map((m) => m[1].toLowerCase());
    for (const [tpl, secs] of [['templates/product-understanding.md', arts.product.sections], ['templates/feature-specification.md', arts.feature.sections]]) {
      if (!fs.existsSync(path.join(dir, tpl))) continue;
      const h = heads(tpl);
      for (const s of secs) if (!h.some((x) => x.startsWith(s.toLowerCase()))) S('error', `${tpl}: missing section "${s}"`);
    }
    const oppTpl = path.join(dir, 'templates/opportunity.md');
    if (fs.existsSync(oppTpl)) {
      const t = fs.readFileSync(oppTpl, 'utf8');
      for (const c of arts.registry.landscape_categories) if (!t.includes(`### ${c}`)) S('error', `templates/opportunity.md: missing landscape category "${c}"`);
      for (const c of ['## Registry', '## Decision Log', '## Opportunity Details', '## Review Summary']) if (!t.includes(c)) S('error', `templates/opportunity.md: missing "${c}"`);
      const hdr = t.match(/^\|\s*ID\s*\|.*$/m);
      if (!hdr) S('error', 'templates/opportunity.md: no Registry header row');
      else for (const col of arts.registry.registry_columns) if (!new RegExp(`\\|\\s*${col}\\s*\\|`, 'i').test(hdr[0] + '|')) S('error', `templates/opportunity.md: Registry column "${col}" missing`);
    }
    // Invocation interface
    for (const c of ['init', 'research', 'opportunities', 'feature', 'refresh', 'handoff', 'full']) if (!new RegExp(`\`${c}`).test(text)) S('error', `SKILL.md does not document command "${c}"`);
    // Approval gates are documented and tool-backed
    for (const k of ['approve-product', 'decide', 'STOP']) if (!text.includes(k)) S('error', `SKILL.md missing approval-gate marker "${k}"`);
    // Lifecycle completeness
    for (const s of ['Discovered', 'Under Evaluation', 'Proposed', 'Approved', 'Rejected', 'Deferred', 'Ready for Implementation', 'Implemented', 'Validated']) if (!lc.statuses.includes(s)) S('error', `lifecycle missing status ${s}`);
    // Default weights sum to 100%
    const sum = Object.values(cfg.scoring.criteria).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-9) S('error', `default scoring weights sum to ${sum}, expected 1`);
    // No hardcoded model names in the methodology
    for (const f of neutral) {
      const t = fs.readFileSync(f, 'utf8');
      if (rel(f) === 'core/config.default.json') continue;
      if (/\b(claude-(opus|sonnet|haiku|fable)-[\w.-]+|gpt-\d[\w.-]*|gemini-[\w.-]+)\b/i.test(t)) S('error', `${rel(f)}: hardcoded model name (use tiers)`);
    }
  }

  // --- Secrets ---
  for (const f of files) {
    if (/\.(png|jpg|gif|ico|zip)$/.test(f)) continue;
    const t = fs.readFileSync(f, 'utf8');
    for (const re of SECRET_PATTERNS) if (re.test(t)) S('error', `${rel(f)}: looks like a secret (${re})`);
  }
}

if (!fs.existsSync(root)) { console.error(`skills root not found: ${root}`); process.exit(2); }
const skills = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
if (!skills.length) add('-', 'error', 'no skills found');
for (const s of skills) await validateSkill(s);

// --- Repo-level ---
if (root === path.join(REPO, 'skills')) {
  for (const e of lockErrors(REPO)) add('lock', 'error', e);
  for (const f of ['README.md', 'LICENSE', 'CONTRIBUTING.md', 'CHANGELOG.md', '.gitignore', 'docs/installation.md', 'docs/architecture.md', 'docs/usage.md', 'docs/development.md']) {
    if (!fs.existsSync(path.join(REPO, f))) add('repo', 'error', `missing ${f}`);
  }
  const inst = path.join(REPO, 'docs/installation.md');
  if (fs.existsSync(inst)) {
    const t = fs.readFileSync(inst, 'utf8');
    for (const p of ['~/.claude/skills', '.claude/skills', '~/.agents/skills', '.agents/skills', 'npx skills add', '--skill product-intelligence']) {
      if (!t.includes(p)) add('repo', 'error', `docs/installation.md does not mention "${p}"`);
    }
  }
}

const errors = results.filter((r) => r.level === 'error');
const warns = results.filter((r) => r.level === 'warn');
if (json) console.log(JSON.stringify({ skills, errors, warns }, null, 2));
else {
  for (const r of results) console.log(`${r.level === 'error' ? 'ERROR  ' : 'warning'} [${r.skill}] ${r.msg}`);
  console.log(`\nvalidated ${skills.length} skill(s): ${errors.length} error(s), ${warns.length} warning(s)`);
}
process.exit(errors.length ? 1 : 0);
