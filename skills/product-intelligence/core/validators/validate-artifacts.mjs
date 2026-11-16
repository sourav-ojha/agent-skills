#!/usr/bin/env node
// Validates the .product/ artifacts of a project against the contracts in core/schemas.
// Usage: node validate-artifacts.mjs [projectDir] [--json] [--today YYYY-MM-DD]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter, sectionText } from '../scripts/lib/fm.mjs';
import { productHash, historyHasProse } from '../scripts/lib/product.mjs';
import { parseRegistry, parseLog, parseDetails, verifyChain } from '../scripts/lib/registry.mjs';
import { lintEvidence, findPlaceholders, daysBetween, isValidDate } from '../scripts/lib/evidence.mjs';
import { computeScore, computeTier, parseRatings } from '../scripts/lib/score.mjs';
import { loadConfig, readJson, CORE_DIR } from '../scripts/lib/config.mjs';

const artifacts = readJson(path.join(CORE_DIR, 'schemas', 'artifacts.json'));
const lifecycle = readJson(path.join(CORE_DIR, 'schemas', 'lifecycle.json'));

export function todayStr() {
  // Local calendar date (not UTC), so "today" matches what the user sees.
  return process.env.PI_TODAY || new Date().toLocaleDateString('sv-SE');
}

function headings(body) {
  return [...body.matchAll(/^##\s+(?:\d+\.\s*)?(.+?)\s*$/gm)].map((m) => m[1].trim());
}

function checkSections(body, required, label, errors) {
  const found = headings(body).map((h) => h.toLowerCase());
  let cursor = -1;
  for (const req of required) {
    const idx = found.findIndex((h, i) => i > cursor && h.startsWith(req.toLowerCase()));
    if (idx === -1) {
      errors.push(`${label}: missing section "${req}"${found.some((h) => h.startsWith(req.toLowerCase())) ? ' (present but out of order)' : ''}`);
    } else cursor = idx;
  }
}

function sectionBody(body, name) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+(?:\d+\.\s*)?/, '').trim().toLowerCase().startsWith(name.toLowerCase()));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s+/.test(lines[i])) { end = i; break; }
  return lines.slice(start + 1, end).join('\n');
}

export function validateProject(dir, { today = todayStr() } = {}) {
  const errors = [];
  const warnings = [];
  const info = { initialized: false, product: null, opportunities: 0, features: 0 };
  const pdir = path.join(dir, '.product');
  if (!fs.existsSync(pdir)) return { errors, warnings, info };
  info.initialized = true;

  const { config, errors: cfgErrors, defaults } = loadConfig(dir);
  errors.push(...cfgErrors);
  const RANK = { Low: 0, Medium: 1, High: 2 };
  if (RANK[config.scoring.min_confidence_for_recommend] < RANK[defaults.scoring.min_confidence_for_recommend]) warnings.push('.product/config.json relaxes the evidence cap (min_confidence_for_recommend is lower than the default); confirm the user chose this');
  if (config.scoring.tiers.recommend_min < defaults.scoring.tiers.recommend_min) warnings.push('.product/config.json lowers scoring.tiers.recommend_min below the default; confirm the user chose this');
  const maxAge = config.freshness.source_max_age_days;

  // ---- PRODUCT.md -----------------------------------------------------------
  const pPath = path.join(pdir, 'PRODUCT.md');
  let product = null;
  if (fs.existsSync(pPath)) {
    const text = fs.readFileSync(pPath, 'utf8');
    const { data, body, error } = splitFrontmatter(text);
    if (error) errors.push(`PRODUCT.md: ${error}`);
    for (const k of artifacts.product.frontmatter_required) if (!(k in data)) errors.push(`PRODUCT.md: missing frontmatter "${k}"`);
    if (data.status && !artifacts.product.status_values.includes(data.status)) errors.push(`PRODUCT.md: invalid status "${data.status}"`);
    checkSections(body, artifacts.product.sections, 'PRODUCT.md', errors);
    if (data.last_reviewed && !isValidDate(data.last_reviewed)) errors.push(`PRODUCT.md: last_reviewed "${data.last_reviewed}" is not YYYY-MM-DD`);
    else if (data.last_reviewed && daysBetween(data.last_reviewed, today) > config.freshness.product_review_days) {
      warnings.push(`PRODUCT.md: last reviewed ${data.last_reviewed}; re-check it against the repository (run "init": it performs the material-change check) and ask the user to confirm`);
    }
    const ev = lintEvidence(text, { file: 'PRODUCT.md', today, maxAgeDays: maxAge });
    errors.push(...ev.errors);
    warnings.push(...ev.warnings);
    if (!ev.tags.some((t) => t.cls === 'fact')) warnings.push('PRODUCT.md: no observed facts are tagged [E: fact; ...]; findings are not traceable');
    if (!/conflicting evidence/i.test(sectionBody(body, 'Assumptions and unanswered questions'))) warnings.push('PRODUCT.md: section 10 has no "Conflicting evidence" subsection (write "None found" if there are none)');
    if (!/\[E:/.test(sectionBody(body, 'Evidence and confidence'))) errors.push('PRODUCT.md: "Evidence and confidence" section contains no evidence tags');
    if (data.status === 'draft') {
      const dph = findPlaceholders(body);
      if (dph.length) warnings.push(`PRODUCT.md (draft): placeholder-like text on body lines ${dph.slice(0, 5).join(', ')}; approval will be refused until removed`);
    }
    if (data.status === 'approved') {
      for (const k of artifacts.product.approved_requires) if (!data[k]) errors.push(`PRODUCT.md: approved but missing "${k}"`);
      if (data.content_hash && data.content_hash !== productHash(text)) {
        errors.push('PRODUCT.md: approved content was modified after approval (hash mismatch). Reopen with "pi.mjs reopen-product", then re-approve after the user confirms.');
      }
      const ph = findPlaceholders(body);
      if (historyHasProse(text)) errors.push('PRODUCT.md: "Revision History" may contain only its table (other text there is part of the approved content)');
      if (ph.length) errors.push(`PRODUCT.md: unresolved placeholders on lines ${ph.slice(0, 5).join(', ')} (approved product context must be complete)`);
    }
    product = data;
    info.product = { status: data.status, revision: data.revision };
  }

  // ---- opportunities.md ------------------------------------------------------
  const oPath = path.join(pdir, 'opportunities.md');
  let rows = [];
  if (fs.existsSync(oPath)) {
    const text = fs.readFileSync(oPath, 'utf8');
    const reg = parseRegistry(text);
    const { body } = splitFrontmatter(text);

    if (!product) errors.push('opportunities.md exists but PRODUCT.md is missing (product context must be established first)');
    else if (!product.approved_at) errors.push('opportunities.md exists but PRODUCT.md was never approved by the user');
    else if (product.status !== 'approved') warnings.push('PRODUCT.md is reopened (draft); opportunity work should wait for re-approval');

    for (const k of artifacts.registry.frontmatter_required) if (!(k in reg.fm)) errors.push(`opportunities.md: missing frontmatter "${k}"`);
    if (reg.fm.review_mode && !artifacts.registry.review_modes.includes(reg.fm.review_mode)) errors.push(`opportunities.md: invalid review_mode "${reg.fm.review_mode}"`);
    if (reg.fm.review_mode === 'self-review' && !reg.fm.review_note) errors.push('opportunities.md: review_mode is self-review but review_note does not explain why no independent reviewer ran');
    if (reg.fm.last_research && !isValidDate(reg.fm.last_research)) errors.push(`opportunities.md: last_research "${reg.fm.last_research}" is not YYYY-MM-DD`);
    else if (reg.fm.last_research && daysBetween(reg.fm.last_research, today) > config.freshness.market_refresh_days) {
      warnings.push(`opportunities.md: market research is ${daysBetween(reg.fm.last_research, today)} days old; consider "refresh"`);
    }

    // Market landscape: every category present, populated or explicitly "None found".
    const landscape = sectionText(text, 'Market Landscape');
    if (landscape === null) {
      if (reg.fm.last_research && reg.fm.last_research !== 'never') errors.push('opportunities.md: last_research is set but "## Market Landscape" is missing');
    } else {
      const cats = {};
      let curCat = null;
      for (const l of landscape.split('\n')) {
        const h = l.match(/^###\s+(.+?)\s*$/);
        if (h) { curCat = h[1].toLowerCase(); cats[curCat] = []; } else if (curCat) cats[curCat].push(l);
      }
      for (const cat of artifacts.registry.landscape_categories) {
        const key = Object.keys(cats).find((k) => k.startsWith(cat.toLowerCase()));
        if (!key) { errors.push(`opportunities.md: Market Landscape missing category "${cat}"`); continue; }
        const content = cats[key].join('\n').trim();
        const hasRow = content.split('\n').filter((l) => l.trim().startsWith('|') && !/^\s*\|?\s*:?-{2,}/.test(l)).length > 1;
        const none = /^none found/im.test(content);
        if (!hasRow && !none) errors.push(`opportunities.md: category "${cat}" is empty (add rows, or write "None found — searched: ..." with evidence)`);
        if (none && !/\[E:/.test(content)) errors.push(`opportunities.md: "None found" for "${cat}" must record what was searched with an evidence tag`);
      }
    }

    // Registry.
    if (!reg.hasRegistry) errors.push('opportunities.md: missing "## Registry" table');
    else {
      for (const c of artifacts.registry.registry_columns) if (!reg.header.includes(c)) errors.push(`opportunities.md: Registry missing column "${c}"`);
    }
    rows = reg.rows;
    info.opportunities = rows.length;
    const details = parseDetails(text);
    const log = parseLog(text);
    if (log.length) {
      if (!log.every((e) => 'seal' in e)) errors.push('Decision Log: missing "Seal" column (rows must be written by pi.mjs decide)');
      else errors.push(...verifyChain(log));
    }
    const seen = new Set();
    const lastDecision = {};
    for (const e of log) lastDecision[e.id] = (e.decision || '').toLowerCase();
    const ALLOWED_AFTER = {
      none: ['Discovered', 'Under Evaluation', 'Proposed'],
      approve: ['Approved', 'Ready for Implementation', 'Implemented', 'Validated'],
      reject: ['Rejected'],
      defer: ['Deferred'],
      research: ['Discovered', 'Under Evaluation', 'Proposed'],
      modify: ['Discovered', 'Under Evaluation', 'Proposed'],
    };
    for (const r of rows) {
      const id = r.id;
      if (!/^OPP-\d{3,}$/.test(id)) { errors.push(`Registry: bad id "${id}" (expected OPP-001)`); continue; }
      if (seen.has(id)) errors.push(`Registry: duplicate id ${id}`);
      seen.add(id);
      if (!lifecycle.statuses.includes(r.status)) { errors.push(`${id}: invalid status "${r.status}"`); continue; }
      if (!artifacts.registry.confidence_values.includes(r.confidence)) errors.push(`${id}: invalid confidence "${r.confidence}"`);
      if (!artifacts.registry.effort_values.includes(r.effort)) errors.push(`${id}: invalid effort "${r.effort}"`);
      const idx = lifecycle.statuses.indexOf(r.status);
      const evaluated = idx >= lifecycle.statuses.indexOf('Proposed');
      const d = details[id];
      if (!d && r.status !== 'Discovered') errors.push(`${id}: no "### ${id}" detail block under "Opportunity Details"`);

      // Score consistency.
      if (evaluated) {
        if (!d) continue;
        const rl = d.text.match(/^\s*(?:[-*]\s*)?\**Ratings\**:?\**\s*(.+)$/im);
        if (!rl) errors.push(`${id}: no "Ratings:" line (needed to reproduce the score)`);
        else {
          const sc = computeScore(parseRatings(rl[1]), config);
          if (sc.errors.length) errors.push(`${id}: ratings invalid: ${sc.errors.join('; ')}`);
          else if (Number(r.score) !== sc.score) errors.push(`${id}: registry score ${r.score} != recomputed ${sc.score}`);
          else {
            const tier = computeTier(sc.score, r.confidence, config);
            if (r.tier !== tier) errors.push(`${id}: tier "${r.tier}" != "${tier}" for score ${sc.score} at ${r.confidence} confidence`);
          }
        }
        for (const label of ['Problem', 'Proposed solution', 'Why it matters', 'Evidence', 'Competitive context', 'Expected value', 'Risks']) {
          if (!new RegExp(`\\**${label}\\**\\s*:`, 'i').test(d.text)) errors.push(`${id}: detail missing "${label}"`);
        }
        if (!/\[E:/.test(d.text)) errors.push(`${id}: no evidence tags in detail (an opportunity without evidence cannot be proposed)`);
        else {
          // Confidence cannot exceed what the cited evidence supports: High needs 2+ distinct facts at medium+ confidence, Medium needs 1.
          const strong = new Set(lintEvidence(d.text, { file: id, today }).tags.filter((t) => t.cls === 'fact' && t.conf !== 'low').map((t) => t.src));
          const maxConf = strong.size >= 2 ? 'High' : strong.size === 1 ? 'Medium' : 'Low';
          if (RANK[r.confidence] > RANK[maxConf]) errors.push(`${id}: confidence ${r.confidence} exceeds what the cited evidence supports (${maxConf}: ${strong.size} distinct fact source(s) at medium+ confidence)`);
        }
        if (r.confidence === 'Low' && r.status === 'Proposed' && r.tier === 'Recommend') errors.push(`${id}: low-confidence opportunity presented as Recommend`);
        if (reg.fm.review_mode === 'pending') errors.push(`${id}: status ${r.status} but review_mode is still "pending" (review before proposing)`);
      }

      // Status must agree with the latest logged human decision (no hand-edited approvals, no silent revival).
      const last = lastDecision[id] || 'none';
      if (['Approved', 'Rejected', 'Deferred'].includes(r.status) || idx >= lifecycle.statuses.indexOf('Ready for Implementation')) {
        const want = r.status === 'Rejected' ? 'reject' : r.status === 'Deferred' ? 'defer' : 'approve';
        if (!log.some((e) => e.id === id && (e.decision || '').toLowerCase() === want)) errors.push(`${id}: status ${r.status} has no "${want}" entry in the Decision Log (decisions come from the user)`);
      }
      if (ALLOWED_AFTER[last] && !ALLOWED_AFTER[last].includes(r.status)) errors.push(`${id}: status "${r.status}" contradicts the latest logged decision "${last}" (allowed: ${ALLOWED_AFTER[last].join(', ')}); decided items change only through "pi decide"`);

      // Feature linkage.
      const feat = r.feature && r.feature !== '-' ? r.feature : null;
      if (feat && !lifecycle.feature_allowed_statuses.includes(r.status)) errors.push(`${id}: has feature ${feat} but status is ${r.status} (specs only for approved opportunities)`);
      if (feat && !fs.existsSync(path.join(pdir, 'features', `${feat}.md`))) errors.push(`${id}: feature ${feat} not found in .product/features/`);
      if (['Ready for Implementation', 'Implemented', 'Validated'].includes(r.status) && !feat) errors.push(`${id}: status ${r.status} but no feature spec linked`);
    }
    for (const id of Object.keys(details)) if (!seen.has(id)) warnings.push(`Detail block ${id} has no registry row`);
    for (const id of new Set(log.map((e) => e.id))) if (!seen.has(id)) errors.push(`Decision Log mentions ${id} but the registry has no such row (decided opportunities must not be deleted)`);

    const ev = lintEvidence(text, { file: 'opportunities.md', today, maxAgeDays: maxAge });
    errors.push(...ev.errors);
    warnings.push(...ev.warnings);

    if (rows.length === 0) {
      if (reg.fm.conclusion) {
        const c = sectionText(text, 'Conclusion');
        if (!c || !c.trim()) errors.push('opportunities.md: conclusion set but "## Conclusion" section is empty');
        else if (!/\[E:/.test(c)) errors.push('opportunities.md: "No actionable opportunities" conclusion needs evidence tags explaining what was considered');
      } else if (reg.fm.last_research && reg.fm.last_research !== 'never') {
        warnings.push('opportunities.md: registry is empty; set `conclusion: no-actionable-opportunities` with a Conclusion section, or continue discovery');
      }
    }
    const ph = findPlaceholders(body);
    if (ph.length) warnings.push(`opportunities.md: placeholder text on lines ${ph.slice(0, 5).join(', ')}`);
  }

  // ---- features ---------------------------------------------------------------
  const fdir = path.join(pdir, 'features');
  if (fs.existsSync(fdir)) {
    for (const f of fs.readdirSync(fdir).filter((n) => n.endsWith('.md')).sort()) {
      info.features++;
      const label = `features/${f}`;
      const text = fs.readFileSync(path.join(fdir, f), 'utf8');
      const { data, body, error } = splitFrontmatter(text);
      if (error) errors.push(`${label}: ${error}`);
      if (!/^FEATURE-\d{3,}\.md$/.test(f)) errors.push(`${label}: filename must be FEATURE-NNN.md`);
      for (const k of artifacts.feature.frontmatter_required) if (!(k in data)) errors.push(`${label}: missing frontmatter "${k}"`);
      if (data.id && `${data.id}.md` !== f) errors.push(`${label}: id "${data.id}" does not match filename`);
      if (data.status && !artifacts.feature.status_values.includes(data.status)) errors.push(`${label}: invalid status "${data.status}"`);
      const row = rows.find((r) => r.id === data.opportunity);
      if (!row) errors.push(`${label}: opportunity "${data.opportunity}" not in registry`);
      else {
        if (!lifecycle.feature_allowed_statuses.includes(row.status)) errors.push(`${label}: opportunity ${row.id} is "${row.status}" — specs may only exist for approved opportunities`);
        if (row.feature !== data.id) errors.push(`${label}: registry feature column for ${row.id} is "${row.feature}", expected ${data.id}`);
      }
      if (!product || product.status !== 'approved') warnings.push(`${label}: PRODUCT.md is not currently approved`);
      else if (data.product_revision && Number(data.product_revision) < Number(product.revision)) warnings.push(`${label}: written against product revision ${data.product_revision}; baseline is now ${product.revision}`);
      checkSections(body, artifacts.feature.sections, label, errors);
      const ac = sectionBody(body, 'Acceptance criteria');
      if (!/\bGiven\b/.test(ac) || !/\bWhen\b/.test(ac) || !/\bThen\b/.test(ac)) errors.push(`${label}: Acceptance criteria must be testable Given/When/Then statements`);
      const unresolved = sectionBody(body, 'Unresolved decisions');
      const rowReady = row && ['Ready for Implementation', 'Implemented', 'Validated'].includes(row.status);
      if ((data.status !== 'draft' || rowReady) && /\[BLOCKING\]/i.test(unresolved)) errors.push(`${label}: [BLOCKING] unresolved decisions exist but the spec/opportunity is marked ready`);
      if (rowReady && data.status === 'draft') errors.push(`${label}: opportunity ${row.id} is "${row.status}" but the spec is still status: draft`);
      const ph = findPlaceholders(body);
      if (ph.length) errors.push(`${label}: placeholder text on lines ${ph.slice(0, 5).join(', ')}`);
      const ev = lintEvidence(text, { file: label, today, maxAgeDays: maxAge });
      errors.push(...ev.errors);
      warnings.push(...ev.warnings);
      if (!/\[E:|ref:|OPP-\d+/.test(sectionBody(body, 'Research references'))) errors.push(`${label}: Research references must cite evidence tags or the originating OPP id`);
    }
  }
  return { errors, warnings, info };
}

// ---- CLI --------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const ti = args.indexOf('--today');
  const today = ti > -1 ? args[ti + 1] : todayStr();
  const dir = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--today') || '.');
  const res = validateProject(dir, { today });
  if (json) console.log(JSON.stringify(res, null, 2));
  else {
    if (!res.info.initialized) console.log(`No .product/ in ${dir} (nothing to validate).`);
    for (const e of res.errors) console.log(`ERROR   ${e}`);
    for (const w of res.warnings) console.log(`warning ${w}`);
    console.log(`\n${res.errors.length} error(s), ${res.warnings.length} warning(s)`);
  }
  process.exit(res.errors.length ? 1 : 0);
}
