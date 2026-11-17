#!/usr/bin/env node
// Task-ledger helper for the implementer skill. Zero dependencies.
// usage: node impl.mjs <init|plan|batch|start|finish|pass|block|ruling|status> [id] --name N [--dir D] ...
import fs from 'node:fs';
import path from 'node:path';
import { validatePlan, nextBatch, startTask, finishTask, blockTask, passTask, safeName, TIERS } from './lib/ledger.mjs';

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
const opt = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]; else pos.push(argv[i]);
}
const [cmd, id] = pos;
const HELP = 'commands: init --tier T0-T3 | plan --file F | batch [--max N] | start ID | finish ID | pass ID --cmd C --exit 0 | block ID --reason R | ruling --what W --why Y --cost C | status (all need --name N, optional --dir D)';
if (!cmd || cmd === 'help') { console.log(HELP); process.exit(0); }

let name;
try { name = safeName(opt.name); } catch (e) { die(e.message); }
const base = path.join(path.resolve(opt.dir || '.'), '.implementation', name);
const file = path.join(base, 'tasks.json');
const log = path.join(base, 'log.md');

function load() {
  if (!fs.existsSync(file)) die(`no ledger at ${file}; run init first`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`ledger is invalid JSON (${e.message}); restore it from git or re-plan`); }
}
function save(p) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
const run = (fn) => { try { fn(); } catch (e) { die(e.message); } };

if (cmd === 'init') {
  if (!TIERS.includes(opt.tier)) die(`--tier must be one of ${TIERS.join(', ')}`);
  if (fs.existsSync(file)) die('ledger already exists');
  fs.mkdirSync(base, { recursive: true });
  save({ name, tier: opt.tier, spec: opt.spec || null, tasks: [] });
  console.log(`initialised ${path.relative(process.cwd(), file)}`);
} else if (cmd === 'plan') {
  const p = load();
  if (p.tasks.some((t) => t.status !== 'pending')) die('plan refused: some tasks already started; re-planning would erase progress');
  let incoming;
  try { incoming = JSON.parse(fs.readFileSync(opt.file, 'utf8')); } catch (e) { die(`cannot read plan file: ${e.message}`); }
  const tasks = (incoming.tasks || []).map((t) => ({ deps: [], status: 'pending', passes: false, evidence: null, ...t }));
  const next = { ...p, tasks };
  const errs = validatePlan(next);
  if (errs.length) die(`invalid plan:\n- ${errs.join('\n- ')}`);
  save(next);
  console.log(`planned ${tasks.length} task(s)`);
} else if (cmd === 'batch') {
  console.log(JSON.stringify(nextBatch(load(), Number(opt.max) || 4)));
} else if (['start', 'finish', 'block', 'pass'].includes(cmd)) {
  if (!id) die(`${cmd} needs a task id`);
  const p = load();
  run(() => {
    if (cmd === 'start') startTask(p, id);
    else if (cmd === 'finish') finishTask(p, id);
    else if (cmd === 'block') blockTask(p, id, opt.reason);
    else passTask(p, id, { cmd: opt.cmd, exit: opt.exit === undefined ? undefined : Number(opt.exit) });
  });
  save(p);
  console.log(`${id}: ${cmd} ok`);
} else if (cmd === 'ruling') {
  if (!opt.what || !opt.why || !opt.cost) die('ruling needs --what, --why and --cost');
  fs.mkdirSync(base, { recursive: true });
  fs.appendFileSync(log, `- ${new Date().toISOString().slice(0, 10)} Ruling: ${opt.what} — ${opt.why} — cost if wrong: ${opt.cost}\n`);
  console.log('ruling logged');
} else if (cmd === 'status') {
  const p = load();
  const passed = p.tasks.filter((t) => t.passes).length;
  console.log(`${p.name} [${p.tier}] ${passed}/${p.tasks.length} passed`);
  for (const t of p.tasks) console.log(`  ${t.id} ${t.status}${t.passes ? ' passed' : ''} - ${t.title}`);
  const nb = nextBatch(p);
  console.log(passed === p.tasks.length && p.tasks.length ? 'next: all passed; run the final review' : `next batch: ${nb.join(', ') || '(none ready)'}`);
} else die(HELP);
