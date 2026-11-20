#!/usr/bin/env node
// Fake `gh` for delivery-orchestrator tests. State lives in $FAKE_GH_STATE (JSON); real git does the merging.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sp = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
const args = process.argv.slice(2);
st.calls.push(args);
(st.tokens ||= []).push(process.env.GH_TOKEN || null);
const save = () => fs.writeFileSync(sp, JSON.stringify(st, null, 2));
const out = (o) => { save(); console.log(typeof o === 'string' ? o : JSON.stringify(o)); process.exit(0); };
const fail = (m, code = 1) => { save(); console.error(m); process.exit(code); };
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
const find = (x) => st.prs.find((p) => String(p.number) === String(x) || p.head === x);
const headSha = (p) => git(st.origin, 'rev-parse', `refs/heads/${p.head}`).stdout.trim();

const pushCommit = (branch, msg) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fakepush-'));
  git(os.tmpdir(), 'clone', '-q', st.origin, tmp);
  git(tmp, 'config', 'user.email', 'b@x'); git(tmp, 'config', 'user.name', 'bot');
  git(tmp, 'checkout', '-q', branch);
  git(tmp, 'commit', '-q', '--allow-empty', '-m', msg);
  git(tmp, 'push', '-q', 'origin', branch);
};

const [a, b] = args;
const accounts = st.accounts || { work: 'tok-work', personal: 'tok-personal' };
if (a === 'auth' && b === 'token') { const u = flag('--user'); if (!accounts[u]) fail(`no token found for ${u}`); out(accounts[u]); }
if (a === 'api' && /^repos\/[^/]+\/[^/]+\/branches\/[^/]+\/protection$/.test(b || '')) { if (st.protection) out(st.protection); fail('gh: Not Found (HTTP 404)'); }
if (a === 'api' && /^repos\/[^/]+\/[^/]+\/rules\/branches\/[^/]+$/.test(b || '')) { if (st.rules) out(st.rules); fail('gh: Not Found (HTTP 404)'); }
// Commit statuses: `api -X POST repos/o/r/statuses/<sha> -f k=v ...` records one status; `api repos/o/r/commits/<sha>/status` lists them.
const apiPath = a === 'api' ? args.slice(1).find((x) => /^repos\//.test(x)) : undefined;
const fields = () => { const o = {}; args.forEach((x, i) => { if (['-f', '-F', '--field', '--raw-field'].includes(x) && typeof args[i + 1] === 'string') { const s = args[i + 1]; const k = s.indexOf('='); o[s.slice(0, k)] = s.slice(k + 1); } }); return o; };
if (apiPath && /^repos\/[^/]+\/[^/]+\/statuses\/[0-9a-f]{40}$/.test(apiPath) && flag('-X') === 'POST') {
  if (st.statusRefuse) fail(st.statusRefuse);
  const sha = apiPath.split('/').pop(); const f = fields();
  ((st.statuses ||= {})[sha] ||= []).push(f);
  out({ state: f.state, context: f.context, description: f.description });
}
if (apiPath && /^repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]{40}\/status$/.test(apiPath)) {
  const sha = apiPath.split('/')[4];
  const latest = new Map(); for (const s of (st.statuses?.[sha] || [])) latest.set(s.context, s);
  const list = [...latest.values()];
  out({ sha, state: list.length && list.every((s) => s.state === 'success') ? 'success' : 'pending', statuses: list });
}
if (a === 'api' && b === 'user') { const t = process.env.GH_TOKEN; const who = Object.keys(accounts).find((k) => accounts[k] === t); out(st.loginOverride || who || 'default-user'); }
if (a === 'repo' && b === 'view') out({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' }, viewerPermission: st.permission || 'WRITE' });
if (a === 'pr' && b === 'list') { const h = flag('--head'); out([...(st.cross || []).filter((p) => p.head === h), ...st.prs.filter((p) => p.head === h && p.state === 'OPEN').map((p) => ({ number: p.number, url: p.url, isCrossRepository: false }))]); }
if (a === 'pr' && b === 'create') {
  const p = { number: st.prs.length + 1, head: flag('--head'), base: flag('--base'), title: flag('--title'), state: 'OPEN', draft: false, mergeState: 'CLEAN' };
  p.url = `https://github.com/o/r/pull/${p.number}`;
  st.prs.push(p); out(p.url);
}
if (a === 'pr' && b === 'view') {
  const p = find(args[2]); if (!p) fail('no pull request found');
  if (p.mergeStates?.length) p.mergeState = p.mergeStates.length > 1 ? p.mergeStates.shift() : p.mergeStates[0];
  out({ number: p.number, url: p.url, state: p.state, isDraft: p.draft, isCrossRepository: false, autoMergeRequest: p.autoMerge ? { enabledBy: 'x' } : null, mergeStateStatus: p.mergeState, headRefOid: p.state === 'OPEN' ? headSha(p) : p.headSha, headRefName: p.head, baseRefName: p.base, mergeCommit: p.mergeSha ? { oid: p.mergeSha } : null, body: p.body ?? '' });
}
if (a === 'pr' && b === 'edit') {
  const p = find(args[2]); if (!p) fail('no pull request found');
  const bf = flag('--body-file'); if (bf !== undefined) p.body = fs.readFileSync(bf, 'utf8');
  out(p.url);
}
if (a === 'pr' && b === 'checks') {
  const p = find(args[2]);
  if (args.includes('--required')) out(st.required || []);
  if (st.noChecks) fail(`no checks reported on the '${p.head}' branch`);
  if (st.bump > 0) { st.bump--; pushCommit(p.head, 'bump'); }
  const q = st.checkQueue || [];
  let cur = q.length > 1 ? q.shift() : q[0] || [];
  // statusesAsChecks: like GitHub, commit statuses on the head (factory/verified) are listed with the check runs.
  if (st.statusesAsChecks) { const latest = new Map(); for (const x of (st.statuses?.[headSha(p)] || [])) latest.set(x.context, x.state); cur = [...cur, ...[...latest].map(([name, s]) => ({ name, bucket: s === 'success' ? 'pass' : s === 'pending' ? 'pending' : 'fail', link: '', state: s.toUpperCase() }))]; }
  st.lastChecks = cur;
  out(cur);
}
if (a === 'pr' && b === 'update-branch') { const p = find(args[2]); p.mergeState = 'CLEAN'; pushCommit(p.head, 'Merge branch main into branch'); out(''); }
if (a === 'pr' && b === 'merge' && args.includes('--disable-auto')) { find(args[2]).autoMerge = false; out(''); }
if (a === 'pr' && b === 'merge') {
  const p = find(args[2]);
  if (st.mergeRefuse) fail(st.mergeRefuse);
  if (st.mergeQueue) { p.autoMerge = true; out(''); }
  const want = flag('--match-head-commit');
  if (want && want !== headSha(p)) fail('head commit does not match');
  // enforceProtection: like GitHub, refuse unless every required context of st.protection is a passing check of the last
  // `pr checks` answer or a success commit status on the head (e.g. factory/verified posted by the driver).
  if (st.enforceProtection) {
    const req = st.protection?.required_status_checks?.contexts || [];
    const passing = new Set((st.lastChecks || []).filter((c) => c.bucket === 'pass').map((c) => c.name));
    const latest = new Map(); for (const x of (st.statuses?.[headSha(p)] || [])) latest.set(x.context, x.state);
    const missing = req.filter((c) => !passing.has(c) && latest.get(c) !== 'success');
    if (missing.length) fail(`GraphQL: Required status check "${missing[0]}" is expected. (mergePullRequest)`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fakemerge-'));
  git(os.tmpdir(), 'clone', '-q', st.origin, tmp);
  git(tmp, 'config', 'user.email', 'b@x'); git(tmp, 'config', 'user.name', 'bot');
  git(tmp, 'checkout', '-q', p.base);
  const m = git(tmp, 'merge', '--squash', `origin/${p.head}`);
  if (m.status !== 0) fail('merge conflict');
  git(tmp, 'commit', '-q', '-m', `${p.title} (#${p.number})`);
  git(tmp, 'push', '-q', 'origin', p.base);
  p.mergeSha = git(tmp, 'rev-parse', 'HEAD').stdout.trim();
  p.headSha = headSha(p);
  p.state = 'MERGED';
  if (args.includes('--delete-branch')) git(st.origin, 'branch', '-D', p.head);
  if (st.mergeNonzeroAfter) fail('failed to delete local branch');
  out('');
}
fail(`fake gh: unhandled ${args.join(' ')}`);
