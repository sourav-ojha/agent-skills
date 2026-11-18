#!/usr/bin/env node
// Helper for the experience-audit skill. Zero dependencies. usage: node ea.mjs <command> [args] [--dir D] ...
import fs from 'node:fs';
import path from 'node:path';
import { logEvent, runId } from './lib/runlog.mjs';
import { layoutChecks, footerChecks, seoChecks, siteChecks, axeFindings, lighthouseFindings, extractRaw } from './lib/checks.mjs';
import { paths, ensureDir, safeWrite, emptyLedger, load, save, addFindings, rank, groups, decide, checkBy, checkNote, writeFixes, closeRun, validateLedger, reportMarkdown, DECISIONS } from './lib/audit.mjs';
import { fileURLToPath } from 'node:url';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const opt = {}, pos = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) opt[argv[i].slice(2)] = true; else { opt[argv[i].slice(2)] = n; i++; } } else pos.push(argv[i]); }
const [cmd, ...rest] = pos;
const HELP = `commands:
  init [--environment staging|production]     create .experience/
  config                                      effective configuration
  analyze layout|footer|seo|site|axe|lighthouse --file F [--route R] [--capabilities F] [--raw F] [--robots F] [--sitemap F] [--run ID] [--add]
                                              run deterministic checks on probe output; --add records the findings
  add --file F [--run ID]                     add findings from a JSON file (array or {findings:[]}); judgment findings need crop, numbers, passes
  coverage [--routes a,b] [--viewports 1440,390] [--states s1,s2] [--not-covered "text"]
  rank [--top N]                              ranked findings and root-cause groups
  decide <id|group:NAME> ... approve|reject|defer|evidence --by NAME --note "<the user's words>"
  fix                                         write FIX-NNN.md for approved groups (input for the implementer)
  reaudit --run ID --routes a,b --rules r1,r2 close a re-audit: unseen findings on covered routes become verified
  report [--top N]                            write .experience/report.md
  status | validate | retro [--unclear T] [--skipped T] [--improvised T] [--suggest T]
(all accept --dir D; default is the current directory)`;
if (!cmd || cmd === 'help') { console.log(HELP); process.exit(0); }
const dir = path.resolve(opt.dir || '.');
const t0 = Date.now(), extra = {};
process.on('exit', (code) => { if (!['status', 'config', 'help'].includes(cmd)) logEvent(dir, 'experience-audit', runId('ea', 'audit'), { event: cmd, ok: code === 0, ms: Date.now() - t0, ...extra }); });

const readJson = (f, what) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { die(`cannot read ${what || 'file'} ${f}: ${e.message}`); } };
const cfgFor = (l) => { const c = JSON.parse(fs.readFileSync(path.join(CORE, 'config.default.json'), 'utf8')); const up = path.join(paths(dir).base, 'config.json'); if (fs.existsSync(up)) { const u = readJson(up, 'config'); for (const k of Object.keys(u)) c[k] = typeof u[k] === 'object' && !Array.isArray(u[k]) ? { ...c[k], ...u[k] } : u[k]; } if (l?.environment) c.environment = l.environment; return c; };
const run = (fn) => { try { fn(); } catch (e) { die(e.message); } };
const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);

run(() => {
  if (cmd === 'init') {
    const p = paths(dir);
    if (fs.existsSync(p.file)) die('audit already initialised');
    const env = opt.environment || 'staging';
    if (!['staging', 'production'].includes(env)) die('--environment must be staging or production');
    ensureDir(p.base); ensureDir(p.evidence);
    save(dir, emptyLedger(env));
    console.log(`initialised ${path.relative(process.cwd(), p.file) || p.file} (environment: ${env}). Consider ignoring .experience/evidence/ (screenshots may contain personal data).`);
  } else if (cmd === 'config') {
    console.log(JSON.stringify(cfgFor(fs.existsSync(paths(dir).file) ? load(dir) : null), null, 2));
  } else if (cmd === 'analyze') {
    const kind = rest[0];
    if (!opt.file) die('analyze needs --file (probe output or tool results)');
    const l = load(dir), cfg = cfgFor(l);
    const input = readJson(opt.file, 'input');
    const route = opt.route;
    let found = [];
    if (kind === 'layout') found = layoutChecks(route ? { ...input, route } : input, cfg);
    else if (kind === 'footer') found = footerChecks(route ? { ...input, route } : input, cfg, opt.capabilities ? readJson(opt.capabilities, 'capabilities') : []);
    else if (kind === 'seo') found = seoChecks(route ? { ...input, route } : input, cfg, opt.raw ? fs.readFileSync(opt.raw, 'utf8') : undefined);
    else if (kind === 'site') found = siteChecks(Array.isArray(input) ? input : input.snapshots, cfg, { robots: opt.robots ? fs.readFileSync(opt.robots, 'utf8') : undefined, sitemap: opt.sitemap ? fs.readFileSync(opt.sitemap, 'utf8') : undefined });
    else if (kind === 'axe') found = axeFindings(input, { route: route || '/', viewport: opt.viewport ? Number(opt.viewport) : undefined });
    else if (kind === 'lighthouse') found = lighthouseFindings(input, { route: route || '/' });
    else die('analyze needs one of: layout, footer, seo, site, axe, lighthouse');
    extra.kind = kind; extra.found = found.length;
    if (opt.add) { const r = addFindings(l, found, { dir, run: opt.run }); save(dir, l); extra.added = r.added.length; console.log(`found ${found.length}; added ${r.added.length}, merged ${r.merged.length}`); }
    else console.log(JSON.stringify(found, null, 2));
  } else if (cmd === 'add') {
    if (!opt.file) die('add needs --file');
    const l = load(dir), d = readJson(opt.file, 'findings');
    const r = addFindings(l, Array.isArray(d) ? d : d.findings, { dir, run: opt.run });
    save(dir, l); extra.added = r.added.length;
    console.log(`added ${r.added.length}, merged ${r.merged.length}`);
  } else if (cmd === 'coverage') {
    const l = load(dir);
    const merge = (a, b) => [...new Set([...(a || []), ...b])];
    l.coverage.routes = merge(l.coverage.routes, list(opt.routes));
    l.coverage.viewports = merge(l.coverage.viewports, list(opt.viewports).map(Number).filter(Number.isFinite));
    l.coverage.states = merge(l.coverage.states, list(opt.states));
    if (opt['not-covered'] && opt['not-covered'] !== true) l.coverage.not_covered = merge(l.coverage.not_covered, [String(opt['not-covered']).replace(/\s+/g, ' ').slice(0, 200)]);
    save(dir, l); console.log(JSON.stringify(l.coverage));
  } else if (cmd === 'rank') {
    const l = load(dir), top = Number(opt.top) || cfgFor(l).limits.top_findings;
    const r = rank(l, top);
    const fmt = (f) => `${f.id} ${f.severity}/${f.effort} [${f.kind}] ${f.group}: ${f.title}`;
    console.log(`top ${r.top.length}:\n${r.top.map(fmt).join('\n') || '(none)'}\n\nbelow cutoff: ${r.rest.length}; info: ${r.info.length}\n\ngroups:\n${groups(l).map((g) => `${g.group} (${g.findings.length}, worst ${g.severity})`).join('\n') || '(none)'}`);
  } else if (cmd === 'decide') {
    const decision = rest[rest.length - 1], targets = rest.slice(0, -1);
    if (!targets.length || !DECISIONS[decision]) die(`usage: decide <id|group:NAME> ... ${Object.keys(DECISIONS).join('|')} --by NAME --note "..."`);
    const by = checkBy(opt.by), note = checkNote(opt.note);
    const l = load(dir);
    const ids = decide(l, dir, targets, decision, by, note);
    save(dir, l); extra.decided = ids.length; extra.decision = decision;
    console.log(`${decision}: ${ids.join(', ')}`);
  } else if (cmd === 'fix') {
    const l = load(dir), made = writeFixes(l, dir);
    save(dir, l); extra.fixes = made.length;
    console.log(made.length ? `wrote ${made.join(', ')} in .experience/fixes/` : 'no new fix specs (approve findings first, or specs already exist)');
  } else if (cmd === 'reaudit') {
    if (!opt.run || !opt.routes || !opt.rules) die('reaudit needs --run ID --routes a,b --rules r1,r2');
    const l = load(dir), r = closeRun(l, { run: String(opt.run), routes: list(opt.routes), rules: list(opt.rules) });
    save(dir, l); extra.verified = r.verified.length; extra.regressed = r.regressed.length;
    console.log(`verified fixed: ${r.verified.join(', ') || '-'}\nregressed: ${r.regressed.join(', ') || '-'}`);
  } else if (cmd === 'report') {
    const l = load(dir), p = paths(dir);
    ensureDir(p.base);
    safeWrite(p.report, reportMarkdown(l, Number(opt.top) || cfgFor(l).limits.top_findings));
    console.log(`wrote ${path.relative(process.cwd(), p.report) || p.report}`);
  } else if (cmd === 'status') {
    const l = load(dir), c = (s) => l.findings.filter((f) => f.status === s).length;
    console.log(`${l.findings.length} findings: open ${c('open')}, approved ${c('approved')}, deferred ${c('deferred')}, rejected ${c('rejected')}, needs-evidence ${c('needs-evidence')}, verified ${c('verified')}; fixes ${l.fixes.length}; environment ${l.environment}`);
    console.log(l.findings.some((f) => f.status === 'open' && f.severity !== 'Info') ? 'next: report, then the user decides' : l.findings.some((f) => f.status === 'approved') ? 'next: fix, then implementer' : 'next: audit more routes, or reaudit');
  } else if (cmd === 'validate') {
    const l = load(dir), e = validateLedger(l, dir);
    for (const m of e) console.log(`ERROR ${m}`);
    console.log(`${e.length} error(s)`);
    if (e.length) process.exitCode = 1;
  } else if (cmd === 'retro') {
    const notes = Object.fromEntries(['unclear', 'skipped', 'improvised', 'suggest'].filter((k) => opt[k] && opt[k] !== true).map((k) => [k, opt[k]]));
    if (!Object.keys(notes).length) die('retro needs at least one of --unclear, --skipped, --improvised, --suggest');
    Object.assign(extra, notes); console.log('retro logged');
  } else die(HELP);
});
