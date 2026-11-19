// factory verification gate (Phase 1a, Task 6): hardened driver git calls and the untrusted-code sandbox (macOS sandbox-exec).
// The real-sandbox tests run sandboxed node / sh probes and assert what the OS actually allows. They are skipped ONLY when
// sandboxAvailable() is false (non-macOS, or a nested sandbox where sandbox_apply fails); the pure profile tests always run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

const LIB = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib');
const G = await import(path.join(LIB, 'gitsafe.mjs'));
const S = await import(path.join(LIB, 'sandbox.mjs'));
const P = await import(path.join(LIB, 'proc.mjs'));

const AVAIL = S.sandboxAvailable();
const SKIP = AVAIL.ok ? false : `real sandbox unavailable here (${AVAIL.reason}); only the pure profile tests ran`;
if (SKIP) console.log(`# factory-sandbox: SKIPPING real-sandbox tests: ${SKIP}`);

const rnd = () => crypto.randomBytes(6).toString('hex');
const tmp = (t, prefix = 'factory-sbx-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: G.gitEnv() });
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });
const serve = (t, port, host = '127.0.0.1') => new Promise((res, rej) => {
  const s = net.createServer((c) => { c.on('error', () => {}); c.end('hi'); }); s.on('error', rej);
  s.listen(port, host, () => { t.after(() => new Promise((r) => s.close(r))); res(s.address().port); });
});
const gone = (t, p) => t.after(() => fs.rmSync(p, { recursive: true, force: true }));

// A FACTORY_HOME with a sentinel secret, a worktree (git repo) inside FACTORY_HOME/work like the real layout, a run temp dir, an outside dir.
function world(t, { workUnderHome = true } = {}) {
  const root = tmp(t);
  const fh = path.join(root, 'fh');
  fs.mkdirSync(path.join(fh, 'scenarios'), { recursive: true });
  fs.writeFileSync(path.join(fh, 'scenarios', 'secret.txt'), 'SENTINEL-SECRET\n');
  const work = workUnderHome ? path.join(fh, 'work', 'wt') : path.join(root, 'wt');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q');
  fs.writeFileSync(path.join(work, 'mod.js'), 'module.exports = 42;\n');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'normal.txt'), 'NORMAL\n');
  const tmpDir = S.makeRunTemp(fh);
  t.after(() => S.removeRunTemp(tmpDir));
  return { root, fh, work, outside, tmpDir, unsafe: !workUnderHome };
}
const profileOf = (w, network = 'none', extra = {}) => S.sandboxProfile({ writable: [w.work], tmpDir: w.tmpDir, network, factoryHome: w.fh, unsafeAllowOutsideFactoryHome: w.unsafe, ...extra });

// Runs `node -e <code> ...args` sandboxed; the code writes its findings as JSON to $PROBE_OUT inside the run temp dir
// (runCmd's tail is redacted, so stdout cannot carry paths or long tokens).
const HEAD = `const fs=require('fs'),net=require('net'),cp=require('child_process'),path=require('path'),os=require('os');
const t=(f)=>{try{const v=f();return v===undefined?'OK':v}catch(e){return e.code||String(e.message).slice(0,60)}};
const conn=(h,p)=>new Promise(r=>{const s=net.connect({host:h,port:p});s.setTimeout(1500,()=>{s.destroy();r('TIMEOUT')});s.on('connect',()=>{s.destroy();r('OK')});s.on('error',e=>r(e.code))});
const listen=(h,p)=>new Promise(r=>{const s=net.createServer();s.on('error',e=>r(e.code));s.listen(p,h,()=>{s.close();r('OK')})});
const A=process.argv.slice(1);const out=(o)=>fs.writeFileSync(process.env.PROBE_OUT,JSON.stringify(o));\n`;
async function sb(w, code, { network = 'none', args = [], cwd = w.work, profile } = {}) {
  const file = path.join(w.tmpDir, `probe-${rnd()}.json`);
  const env = { ...P.allowEnv(null), PROBE_OUT: file };
  const r = await S.runSandboxed(['node', '-e', HEAD + code, ...args], { cwd, env, profile: profile ?? profileOf(w, network), tmpDir: w.tmpDir, timeoutS: 60 });
  assert.ok(fs.existsSync(file), `probe wrote no result (exit ${r.code}): ${r.tail}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---- gitSafe -----------------------------------------------------------------------------------------------------------------
function repoWithCommit(t) {
  const d = tmp(t, 'factory-git-');
  git(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\n');
  git(d, 'add', '.'); git(d, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'c1');
  git(d, 'branch', 'other');
  return d;
}
const plantHook = (repo, name, marker) => {
  const h = path.join(repo, '.git', 'hooks', name);
  fs.writeFileSync(h, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
};

test('gitSafe: a planted post-checkout hook does not run (plain git runs it)', (t) => {
  const repo = repoWithCommit(t); const marker = path.join(repo, 'HOOK-RAN');
  plantHook(repo, 'post-checkout', marker);
  const r = G.gitSafe(repo, 'checkout', '-q', 'other');
  assert.equal(r.code, 0, r.err); assert.equal(fs.existsSync(marker), false, 'gitSafe ran the hook');
  git(repo, 'checkout', '-q', 'main');
  assert.equal(fs.existsSync(marker), true, 'control: plain git should run the planted hook');
});

test('gitSafe second layer (allowlist bypassed with verified:true): repo-configured fsmonitor, external diff, textconv and ext:: never run', (t) => {
  const repo = repoWithCommit(t); const mk = (n) => path.join(repo, `${n}-RAN`);
  const script = (n) => { const f = path.join(repo, `${n}.sh`); fs.writeFileSync(f, `#!/bin/sh\ntouch "${mk(n)}"\n`, { mode: 0o755 }); return f; };
  git(repo, 'config', 'core.fsmonitor', script('fsmon'));
  git(repo, 'config', 'diff.external', script('extdiff'));
  git(repo, 'config', 'protocol.ext.allow', 'always');
  git(repo, 'config', 'diff.conv.textconv', script('textconv'));
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt diff=conv\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  assert.throws(() => G.gitSafe(repo, 'status'), /^Error: git config not allowed: core\.fsmonitor$/);
  const v = { verified: true };
  assert.equal(G.gitSafeOpts(repo, ['status', '--porcelain'], v).code, 0);
  const d = G.gitSafeOpts(repo, ['diff'], v);
  assert.equal(d.code, 0); assert.match(d.out, /^-one\n\+two\n/m);
  G.gitSafeOpts(repo, ['-C', repo, 'diff'], v); // the guard finds the subcommand after global options
  G.gitSafeOpts(repo, ['--no-pager', 'blame', 'a.txt'], v);
  G.gitSafeOpts(repo, ['log', '-p', '-1'], v);
  G.gitSafeOpts(repo, ['ls-remote', `ext::${script('ext')}`], { ...v, unsafeAllowLocalUrls: true }); // the arg check alone would refuse ext::
  assert.throws(() => G.gitSafeOpts(repo, ['ls-remote', `ext::${script('ext')}`], v), /git URL not allowed: argument 1/);
  for (const n of ['fsmon', 'extdiff', 'ext', 'textconv']) assert.equal(fs.existsSync(mk(n)), false, `${n} ran under gitSafe`);
  git(repo, 'diff'); // control: plain git honours the planted diff.external
  assert.equal(fs.existsSync(mk('extdiff')), true, 'control: plain git should run diff.external');
});

test('gitSafe: repo-configured core.sshCommand is replaced by plain ssh', (t) => {
  const repo = repoWithCommit(t); const marker = path.join(repo, 'SSH-RAN');
  const f = path.join(repo, 'ssh.sh'); fs.writeFileSync(f, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
  git(repo, 'config', 'core.sshCommand', f);
  assert.throws(() => G.gitSafe(repo, 'status'), /git config not allowed: core\.sshcommand/);
  // Port 1 on loopback: ssh fails immediately with connection refused; nothing leaves the machine.
  const r = G.gitSafeOpts(repo, ['ls-remote', 'ssh://git@127.0.0.1:1/x.git'], { verified: true, unsafeAllowLocalUrls: true });
  assert.notEqual(r.code, 0);
  assert.equal(fs.existsSync(marker), false, 'gitSafe ran the repo-configured ssh command');
});

test('gitSafe: raw result: stdout is not trimmed, the real exit code is kept, args are argv', (t) => {
  const repo = repoWithCommit(t);
  const r = G.gitSafe(repo, 'show', 'HEAD:a.txt');
  assert.equal(r.out, 'one\n');
  const bad = G.gitSafe(repo, 'rev-parse', '--verify', '-q', 'refs/heads/nope');
  assert.equal(bad.code, 1);
  assert.equal(G.gitSafe(repo, 'cat-file', '-t', 'nope-$(touch PWN)').code, 128);
  assert.equal(fs.existsSync(path.join(repo, 'PWN')), false);
  assert.throws(() => G.gitSafe(repo, 'log', 1), /string/);
});

test('gitSafe: GIT_* environment is scrubbed (GIT_DIR, GIT_EXTERNAL_DIFF, GIT_CONFIG_*), global config ignored', (t) => {
  const repo = repoWithCommit(t); const other = repoWithCommit(t); const marker = path.join(repo, 'ENV-RAN');
  const f = path.join(repo, 'x.sh'); fs.writeFileSync(f, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  const home = tmp(t, 'factory-home-'); fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = PlantedGlobal\n');
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, {
    GIT_DIR: path.join(other, '.git'), GIT_EXTERNAL_DIFF: f, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'PlantedEnv',
    HOME: home,
  });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
  const d = G.gitSafe(repo, 'diff');
  assert.match(d.out, /\+changed/, `${d.code} ${d.err}: GIT_DIR must not redirect gitSafe to another repo`);
  assert.equal(fs.existsSync(marker), false, 'GIT_EXTERNAL_DIFF ran');
  assert.equal(G.gitSafe(repo, 'config', 'user.name').out.trim(), '', 'env or global config leaked into gitSafe');
  const e = G.gitEnv({ PATH: '/bin', HOME: '/h', GIT_SSH_COMMAND: 'x', GIT_ASKPASS: 'x', GIT_PAGER: 'x', git_dir: 'x', GIT_CONFIG_PARAMETERS: 'x', SSH_ASKPASS: 'x' });
  assert.deepEqual(e, { PATH: '/bin', HOME: '/h', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', SSH_ASKPASS_REQUIRE: 'never', GIT_NO_REPLACE_OBJECTS: '1' });
  assert.ok(G.GIT_SAFE_FLAGS.includes('core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'));
});

// ---- availability and refusal (pure) ------------------------------------------------------------------------------------------
test('sandboxAvailable: non-darwin is unavailable; requireSandbox and runSandboxed refuse (no fallback)', async () => {
  assert.deepEqual(S.sandboxAvailable({ platform: 'linux' }), { ok: false, reason: 'sandbox-exec is macOS only' });
  assert.throws(() => S.requireSandbox({ platform: 'linux' }), /refusing to run builder code: there is no unsandboxed fallback/);
  assert.equal(S.sandboxAvailable({ exec: '/nonexistent/sandbox-exec' }).ok, false);
  await assert.rejects(S.runSandboxed(['/usr/bin/true'], { profile: '(version 1)(allow default)', sandbox: { platform: 'linux' } }), /no unsandboxed fallback/);
  assert.throws(() => S.startSandboxed(['/usr/bin/true'], { profile: '(version 1)(allow default)', sandbox: { platform: 'linux' } }), /no unsandboxed fallback/);
});

test('sandboxAvailable: a sandbox-exec that runs the command but enforces nothing is rejected', { skip: process.platform !== 'darwin' && 'macOS only' }, (t) => {
  const d = tmp(t); const fake = path.join(d, 'sandbox-exec');
  fs.writeFileSync(fake, '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
  assert.deepEqual(S.sandboxAvailable({ exec: fake }), { ok: false, reason: 'sandbox-exec ran but did not enforce a deny rule' });
  const fail = path.join(d, 'nested'); fs.writeFileSync(fail, '#!/bin/sh\necho "sandbox_apply: Operation not permitted" >&2\nexit 71\n', { mode: 0o755 });
  assert.match(S.sandboxAvailable({ exec: fail }).reason, /cannot apply a profile here: sandbox_apply: Operation not permitted/);
});

test('runSandboxed: refuses without a sandboxProfile() profile', async () => {
  await assert.rejects(S.runSandboxed(['/usr/bin/true'], {}), /profile/);
});

// ---- profile text (pure) ------------------------------------------------------------------------------------------------------
test('sandboxProfile: realpaths, deny-before-allow order, default secrets, .git and mach rules', (t) => {
  const root = tmp(t); // already realpath'd (/private/var/...)
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-raw-')); gone(t, raw);
  const fh = path.join(root, 'fh'); fs.mkdirSync(path.join(fh, 'tmp'), { recursive: true });
  const prof = S.sandboxProfile({ writable: [raw], tmpDir: path.join(fh, 'tmp'), network: 'none', factoryHome: fh, home: '/Users/someone', readAllow: [], unsafeAllowOutsideFactoryHome: true });
  const realRaw = fs.realpathSync(raw);
  if (realRaw !== raw) assert.ok(!prof.includes(`"${raw}"`), 'non-realpath writable leaked into the profile');
  assert.ok(prof.includes(`(subpath "${realRaw}")`));
  const idx = (s) => { const i = prof.indexOf(s); assert.ok(i >= 0, `missing ${s}\n${prof}`); return i; };
  assert.ok(idx('(allow default)') < idx('(deny file-write*)'));
  assert.ok(idx('(deny file-write*)') < idx('(allow file-read* file-write*'));
  assert.ok(idx('(deny file-read*') < idx('(allow file-read* file-write*'));
  assert.ok(idx('(allow file-read* file-write*') < idx(`(deny file-write* (regex #"^${realRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.*/)?\\.[gG][iI][tT](/.*)?$")`));
  assert.ok(idx('(deny mach-lookup)') < idx('(allow mach-lookup'));
  const lines = prof.split('\n');
  const denyReads = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith('(deny file-read*'));
  assert.equal(denyReads.length, 2, 'one deny of whole roots first, one credential deny last');
  const [roots, creds] = denyReads;
  for (const r of ['/Users/someone', '/Users', fh, `/private/tmp/claude-${process.getuid()}`]) assert.ok(roots[0].includes(`(subpath "${r}")`), r);
  const lastAllow = Math.max(...lines.map((l, i) => (l.startsWith('(allow file-read') ? i : -1)));
  assert.ok(roots[1] < lines.findIndex((l) => l.startsWith('(allow file-read*')) && creds[1] > lastAllow, 'roots denied before every read allow; credentials after');
  for (const s of ['.ssh', '.aws', '.config/gh', '.netrc', '.git-credentials', '.npmrc', '.docker', '.kube', '.config/gcloud', '.codex', 'Library/Keychains',
    'Library/Application Support', 'Library/Cookies', '.claude', '.claude.json', '.gnupg', '.zsh_history', '.mcp-auth']) assert.ok(creds[0].includes(`(subpath "/Users/someone/${s}")`), s);
  assert.ok(creds[0].includes('(regex #"^/Users/someone/\\.[^/]*_history$")'), creds[0]);
  assert.ok(!creds[0].includes(`(subpath "${fh}")`), 'FACTORY_HOME must not be re-denied last (it would hide the worktree)');
  assert.ok(idx('(deny signal)') < idx('(allow signal (target same-sandbox))'));
  assert.ok(idx('(deny process-info*)') < idx('(allow process-info* (target self) (target same-sandbox))'));
  assert.equal(S.profileTmpDir(prof), path.join(fh, 'tmp'));
  assert.ok(prof.includes(`(literal "${path.dirname(realRaw)}")`), 'ancestors get stat-only access');
  for (const n of ['com.apple.coreservices.launchservicesd', 'com.apple.cfprefsd', 'com.apple.SecurityServer', 'pasteboard']) assert.ok(!prof.includes(n), n);
});

test('sandboxProfile: escaping, control characters, relative/missing/protected paths and bad network specs', (t) => {
  const root = tmp(t);
  const weird = path.join(root, 'we"ird\\dir'); fs.mkdirSync(weird);
  const U = { unsafeAllowOutsideFactoryHome: true };
  // A worktree path is used inside an SBPL regex literal, which cannot carry a '"': such a writable dir is refused clearly.
  assert.throws(() => S.sandboxProfile({ writable: [weird], network: 'none', factoryHome: path.join(root, 'fh'), ...U }), /cannot be used in an SBPL regex/);
  const plain = path.join(root, 'plain'); fs.mkdirSync(plain);
  const prof = S.sandboxProfile({ writable: [plain], readDeny: [weird], network: 'none', factoryHome: path.join(root, 'fh'), ...U });
  assert.ok(prof.includes(`(subpath "${root}/we\\"ird\\\\dir")`), prof);
  assert.throws(() => S.sandboxProfile({ writable: [path.join(root, 'a\nb')], network: 'none' }), /control character/);
  assert.throws(() => S.sandboxProfile({ writable: [root], readDeny: [`${root}/x\u0000`], network: 'none' }), /control character/);
  assert.throws(() => S.sandboxProfile({ writable: ['rel/dir'], network: 'none' }), /absolute/);
  assert.throws(() => S.sandboxProfile({ writable: [path.join(root, 'missing')], network: 'none' }), /does not exist/);
  assert.throws(() => S.sandboxProfile({ writable: [root], network: 'none', factoryHome: path.join(root, 'fh'), ...U }), /contains protected path/);
  assert.throws(() => S.sandboxProfile({ writable: [os.homedir()], network: 'none', ...U }), /contains protected path/);
  assert.throws(() => S.sandboxProfile({ writable: ['/'], network: 'none', ...U }), /must not be \/|protected/);
  assert.throws(() => S.sandboxProfile({ writable: [], readAllow: [path.dirname(root)], network: 'none', factoryHome: path.join(root, 'fh') }), /contains denied root/);
  for (const bad of [undefined, 'all', { localhostPort: 0 }, { localhostPort: 70000 }, { localhostPort: '80' }, { localhostPort: 80, extra: 1 }]) {
    assert.throws(() => S.sandboxProfile({ writable: [plain], network: bad, factoryHome: path.join(root, 'fh'), ...U }), /network|localhostPort/);
  }
});

test('sandboxProfile: network rules per mode', (t) => {
  const root = tmp(t); const base = { writable: [root], factoryHome: '/nonexistent/fh', unsafeAllowOutsideFactoryHome: true };
  const none = S.sandboxProfile({ ...base, network: 'none' });
  assert.match(none, /\(deny network\*\)\n?$/); assert.ok(!/allow network/.test(none));
  const reg = S.sandboxProfile({ ...base, network: 'registries' });
  assert.ok(reg.indexOf('(deny network*)') < reg.indexOf('(allow network-outbound (remote tcp "*:443") (remote tcp "*:80") (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'));
  assert.ok(reg.indexOf('(allow network-outbound (remote tcp') < reg.indexOf('(deny network-outbound (remote ip "localhost:*"))'), 'loopback denied after the 80/443 allow');
  const lp = S.sandboxProfile({ ...base, network: { localhostPort: 4321 } });
  assert.ok(lp.includes('(allow network-outbound (remote ip "localhost:4321"))') && lp.includes('(allow network-bind network-inbound (local ip "localhost:4321"))'));
  assert.ok(!lp.includes('mDNSResponder') && !lp.includes('*:443') && !lp.includes('(deny network-outbound (remote ip "localhost:*"))'));
});

test('makeRunTemp: FACTORY_HOME/tmp/<random>, mode 0700, realpath; removeRunTemp deletes it', (t) => {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fh-')); gone(t, raw);
  const a = S.makeRunTemp(raw); const b = S.makeRunTemp(raw);
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), path.join(fs.realpathSync(raw), 'tmp'));
  assert.equal(fs.statSync(a).mode & 0o777, 0o700);
  assert.equal(fs.realpathSync(a), a);
  S.removeRunTemp(a); S.removeRunTemp(b);
  assert.equal(fs.existsSync(a), false);
});

// ---- real sandbox: filesystem ------------------------------------------------------------------------------------------------
test('sandbox fs: writes inside the worktree and run temp work; writes outside are EPERM', { skip: SKIP }, async (t) => {
  const w = world(t);
  const homeX = path.join(os.homedir(), `factory-sbx-${rnd()}`); const tmpX = `/tmp/factory-sbx-${rnd()}`;
  gone(t, homeX); gone(t, tmpX);
  const r = await sb(w, `out({
    inside: t(()=>fs.writeFileSync(path.join(A[0],'a.txt'),'x')), rel: t(()=>fs.writeFileSync('sub.txt','x')),
    tmp: t(()=>fs.writeFileSync(path.join(os.tmpdir(),'t.txt'),'x')), tmpdirIs: os.tmpdir()===A[5],
    home: t(()=>fs.writeFileSync(A[1],'x')), slashTmp: t(()=>fs.writeFileSync(A[2],'x')), outside: t(()=>fs.writeFileSync(path.join(A[3],'x'),'x')),
    hooks: t(()=>fs.writeFileSync(path.join(A[0],'.git','hooks','post-checkout'),'x')), gitcfg: t(()=>fs.appendFileSync(path.join(A[0],'.git','config'),'x')),
    fhWrite: t(()=>fs.writeFileSync(path.join(A[4],'scenarios','secret.txt'),'x')),
    rename: t(()=>{fs.writeFileSync(path.join(A[5],'mv.txt'),'x');fs.renameSync(path.join(A[5],'mv.txt'),path.join(A[3],'mv.txt'))}),
    mkdirOut: t(()=>fs.mkdirSync(path.join(A[3],'d'))), unlinkOut: t(()=>fs.unlinkSync(path.join(A[3],'normal.txt'))),
    devnull: t(()=>{cp.execFileSync('/bin/sh',['-c','echo x > /dev/null; echo y > /dev/stdout; echo z > /dev/stderr'],{stdio:'ignore'})}),
  })`, { args: [w.work, homeX, tmpX, w.outside, w.fh, w.tmpDir] });
  assert.deepEqual(r, { inside: 'OK', rel: 'OK', tmp: 'OK', tmpdirIs: true, home: 'EPERM', slashTmp: 'EPERM', outside: 'EPERM', hooks: 'EPERM', gitcfg: 'EPERM', fhWrite: 'EPERM', rename: 'EPERM', mkdirOut: 'EPERM', unlinkOut: 'EPERM', devnull: 'OK' });
  for (const p of [homeX, tmpX, path.join(w.outside, 'x'), path.join(w.outside, 'mv.txt')]) assert.equal(fs.existsSync(p), false, p);
  assert.equal(fs.readFileSync(path.join(w.fh, 'scenarios', 'secret.txt'), 'utf8'), 'SENTINEL-SECRET\n');
});

test('sandbox fs: FACTORY_HOME (except this worktree and run temp), the user temp dir and credentials are unreadable; node/npm still work', { skip: SKIP }, async (t) => {
  const w = world(t);
  fs.mkdirSync(path.join(w.fh, 'work', 'other-wt')); fs.writeFileSync(path.join(w.fh, 'work', 'other-wt', 'f'), 'OTHER\n');
  const otherRun = S.makeRunTemp(w.fh); t.after(() => S.removeRunTemp(otherRun));
  const r = await sb(w, `out({
    secret: t(()=>fs.readFileSync(path.join(A[1],'scenarios','secret.txt'),'utf8')), list: t(()=>fs.readdirSync(A[1]).join()),
    listScen: t(()=>fs.readdirSync(path.join(A[1],'scenarios')).join()), ssh: t(()=>fs.readdirSync(path.join(A[3],'.ssh')).length>=0),
    otherWt: t(()=>fs.readFileSync(path.join(A[1],'work','other-wt','f'),'utf8')), listWork: t(()=>fs.readdirSync(path.join(A[1],'work')).join()),
    otherRun: t(()=>fs.readdirSync(A[4]).join()), listTmp: t(()=>fs.readdirSync(path.join(A[1],'tmp')).join()),
    userTmp: t(()=>fs.readFileSync(path.join(A[2],'normal.txt'),'utf8')), etcHosts: t(()=>fs.readFileSync('/etc/hosts','utf8').length>0),
    mod: t(()=>require(path.join(A[0],'mod.js'))), ownTmp: t(()=>{fs.writeFileSync(path.join(os.tmpdir(),'r'),'R');return fs.readFileSync(path.join(os.tmpdir(),'r'),'utf8')}),
    fakeHome: os.homedir()===path.join(A[5],'home'), npm: t(()=>cp.execFileSync('npm',['--version'],{encoding:'utf8'}).trim().length>0),
    cat: t(()=>cp.execFileSync('/bin/cat',[path.join(A[1],'scenarios','secret.txt')],{encoding:'utf8',stdio:['ignore','pipe','pipe']})),
  })`, { args: [w.work, w.fh, w.outside, os.userInfo().homedir, otherRun, w.tmpDir] });
  assert.deepEqual({ ...r, cat: undefined, ssh: undefined }, { secret: 'EPERM', list: 'EPERM', listScen: 'EPERM', otherWt: 'EPERM', listWork: 'EPERM', otherRun: 'EPERM',
    listTmp: 'EPERM', userTmp: 'EPERM', etcHosts: true, mod: 42, ownTmp: 'R', fakeHome: true, npm: true, cat: undefined, ssh: undefined });
  assert.equal(r.ssh, 'EPERM', 'the real ~/.ssh (or the real home itself) must be unreadable');
  assert.notEqual(r.cat, 'SENTINEL-SECRET\n'); assert.match(String(r.cat), /Command failed/);
});

test('sandbox fs: symlink, .., chdir, hard link, /dev/fd and rename-out escapes are denied', { skip: SKIP }, async (t) => {
  const w = world(t); fs.writeFileSync(path.join(w.outside, 'victim.txt'), 'ORIG\n');
  const r = await sb(w, `const W=A[0],O=A[1];
    fs.symlinkSync(O, path.join(W,'lnk')); fs.symlinkSync(path.join(O,'victim.txt'), path.join(W,'flnk'));
    out({
      viaDirLink: t(()=>fs.writeFileSync(path.join(W,'lnk','x'),'x')), viaFileLink: t(()=>fs.writeFileSync(path.join(W,'flnk'),'PWN')),
      dotdot: t(()=>fs.writeFileSync('../../../outside/x','x')), dotdot2: t(()=>fs.writeFileSync(path.join(W,'..','escape'),'x')),
      chdir: t(()=>{process.chdir(O);fs.writeFileSync('x','x')}),
      hardlink: t(()=>fs.linkSync(path.join(O,'victim.txt'), path.join(W,'hl'))),
      devfd: t(()=>{const fd=fs.openSync(path.join(O,'victim.txt'),'r');fs.writeFileSync('/dev/fd/'+fd,'PWN')}),
      secretLink: t(()=>{fs.symlinkSync(path.join(A[2],'scenarios','secret.txt'),path.join(W,'sl'));return fs.readFileSync(path.join(W,'sl'),'utf8')}),
    })`, { args: [w.work, w.outside, w.fh] });
  assert.deepEqual(r, { viaDirLink: 'EPERM', viaFileLink: 'EPERM', dotdot: 'EPERM', dotdot2: 'EPERM', chdir: 'EPERM', hardlink: 'EPERM', devfd: r.devfd, secretLink: 'EPERM' });
  assert.ok(['EPERM', 'EACCES'].includes(r.devfd), `reopening a read-only fd for write via /dev/fd: ${r.devfd}`);
  assert.equal(fs.readFileSync(path.join(w.outside, 'victim.txt'), 'utf8'), 'ORIG\n');
  assert.deepEqual(fs.readdirSync(w.outside).sort(), ['normal.txt', 'victim.txt']);
});

test('sandbox fs: path aliases (/tmp vs /private/tmp, /System/Volumes/Data, case variants, ~) do not reach protected paths', { skip: SKIP }, async (t) => {
  const w = world(t, { workUnderHome: false });
  const secret = path.join(w.fh, 'scenarios', 'secret.txt');
  const aliases = [secret.toUpperCase(), secret.replace('/fh/', '/FH/'), `/System/Volumes/Data${secret}`];
  if (secret.startsWith('/private/var/')) aliases.push(secret.replace('/private/var/', '/var/'));
  const tmpOut = `/private/tmp/factory-sbx-${rnd()}`; gone(t, tmpOut);
  const r = await sb(w, `out({ reads: A.slice(1).map(p=>t(()=>fs.readFileSync(p,'utf8'))),
    tmpAlias: t(()=>fs.writeFileSync(A[0].replace('/private/tmp/','/tmp/'),'x')),
    tilde: t(()=>cp.execFileSync('/bin/sh',['-c','cat ~/.ssh/* ~/.aws/* 2>&1; echo DONE'],{encoding:'utf8',env:{...process.env,HOME:os.homedir()}})) })`, { args: [tmpOut, ...aliases] });
  for (const [i, v] of r.reads.entries()) assert.ok(v === 'EPERM' || v === 'ENOENT', `${aliases[i]} -> ${v}`);
  assert.ok(r.reads.includes('EPERM'));
  assert.equal(r.tmpAlias, 'EPERM'); assert.equal(fs.existsSync(tmpOut), false);
  assert.doesNotMatch(String(r.tilde), /PRIVATE KEY|aws_secret/);
});

test('sandbox: child processes inherit the sandbox; nested sandbox-exec cannot widen it', { skip: SKIP }, async (t) => {
  const w = world(t);
  const r = await sb(w, `const O=A[0];const run=(argv)=>{const p=cp.spawnSync(argv[0],argv.slice(1),{encoding:'utf8'});return p.status};
    out({
      sh: run(['/bin/sh','-c','echo x > "$0"/sh.txt', O]),
      shNode: run(['/bin/sh','-c','node -e "require(\\'fs\\').writeFileSync(process.argv[1]+\\'/n.txt\\',\\'x\\')" "$0"', O]),
      nested: run(['/usr/bin/sandbox-exec','-p','(version 1)(allow default)','/usr/bin/touch', O+'/nested.txt']),
      nestedRead: run(['/usr/bin/sandbox-exec','-p','(version 1)(allow default)','/bin/cat', A[1]]),
    })`, { args: [w.outside, path.join(w.fh, 'scenarios', 'secret.txt')] });
  for (const k of Object.keys(r)) assert.notEqual(r[k], 0, `${k} succeeded`);
  assert.deepEqual(fs.readdirSync(w.outside), ['normal.txt']);
});

test('sandbox: OS services that act outside the sandbox are unreachable (LaunchServices open, cfprefsd, keychain, pasteboard, launchd)', { skip: SKIP }, async (t) => {
  const w = world(t); const marker = path.join(w.outside, 'APP-RAN');
  const app = path.join(w.work, 'Probe.app', 'Contents');
  fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>dev.factory.sbxprobe.${rnd()}</string><key>LSBackgroundOnly</key><true/></dict></plist>`);
  fs.writeFileSync(path.join(app, 'MacOS', 'probe'), `#!/bin/sh\n/usr/bin/touch "${marker}"\n`, { mode: 0o755 });
  const domain = `dev.factory.sbxprobe.${rnd()}`; const label = `dev.factory.sbxprobe.${rnd()}`;
  t.after(() => { spawnSync('defaults', ['delete', domain]); spawnSync('launchctl', ['remove', label]); });
  const r = await sb(w, `const run=(argv)=>{const p=cp.spawnSync(argv[0],argv.slice(1),{encoding:'utf8'});return {code:p.status,out:(p.stdout||'').slice(0,200)}};
    out({ open: run(['/usr/bin/open','-g','-n',A[0]]).code, defaults: run(['/usr/bin/defaults','write',A[1],'k','v']).code,
      keychain: /keychain:/.test(run(['/usr/bin/security','dump-keychain']).out), pbcopy: run(['/bin/sh','-c','echo x | /usr/bin/pbcopy']).code,
      launchd: run(['/bin/launchctl','submit','-l',A[2],'--','/usr/bin/touch',A[3]]).code })`, { args: [path.dirname(app), domain, label, `${marker}-launchd`] });
  await new Promise((res) => setTimeout(res, 1500));
  assert.notEqual(r.open, 0, 'open -n launched an app'); assert.equal(fs.existsSync(marker), false, 'an app launched via LaunchServices ran unsandboxed');
  assert.notEqual(spawnSync('defaults', ['read', domain, 'k'], { encoding: 'utf8' }).stdout.trim(), 'v', 'defaults write reached cfprefsd');
  assert.equal(r.keychain, false, 'security dump-keychain listed the keychain');
  assert.notEqual(r.pbcopy, 0, 'pbcopy reached the pasteboard');
  assert.equal(fs.existsSync(`${marker}-launchd`), false, 'launchctl submit ran a job outside the sandbox');
});

// ---- real sandbox: network ---------------------------------------------------------------------------------------------------
test('sandbox net: localhostPort allows exactly that port (connect + listen); other ports and external IPs are denied', { skip: SKIP }, async (t) => {
  const w = world(t);
  const a = await serve(t, 0); const b = await serve(t, 0);
  try { await serve(t, a, '::1'); } catch { /* ::1 may be unavailable */ }
  const c = await freePort();
  const prof = profileOf(w, { localhostPort: a });
  const r = await sb(w, `(async()=>out({ a: await conn('127.0.0.1',+A[0]), aName: await conn('localhost',+A[0]), b: await conn('127.0.0.1',+A[1]),
    ext: await conn('93.184.216.34',80), extA: await conn('93.184.216.34',+A[0]), listenB: await listen('127.0.0.1',+A[2]) }))()`, { args: [String(a), String(b), String(c)], profile: prof });
  assert.deepEqual(r, { a: 'OK', aName: 'OK', b: 'EPERM', ext: 'EPERM', extA: 'EPERM', listenB: 'EPERM' });
  const c2 = await freePort(); // the app may listen on its own port
  const l = await sb(w, `(async()=>out({ listen: await listen('127.0.0.1',+A[0]), dns: await new Promise(r=>require('dns').lookup('example.com',e=>r(e?e.code:'RESOLVED'))) }))()`, { args: [String(c2)], profile: profileOf(w, { localhostPort: c2 }) });
  assert.equal(l.listen, 'OK'); assert.notEqual(l.dns, 'RESOLVED');
});

test('sandbox net: registries allows only tcp 80/443 to non-loopback hosts (loopback 443/80 and ephemeral ports denied); none denies everything', { skip: SKIP }, async (t) => {
  const w = world(t);
  const eph = await serve(t, 0);
  let p443 = null; try { p443 = await serve(t, 443); } catch { t.diagnostic('could not listen on 127.0.0.1:443; positive 443 check skipped'); }
  const code = `(async()=>out({ eph: await conn('127.0.0.1',+A[0]), p443: A[1]?await conn('127.0.0.1',443):'skip', lo80: await conn('127.0.0.1',80), v6_443: await conn('::1',443), listen: await listen('127.0.0.1',0),
    ssh: await conn('127.0.0.1',22), unix: await new Promise(r=>{const s=net.connect('/private/var/run/mDNSResponder');s.on('connect',()=>{s.destroy();r('OK')});s.on('error',e=>r(e.code))}),
    agent: await new Promise(r=>{if(!process.env.SSH_AUTH_SOCK)return r('none');const s=net.connect(process.env.SSH_AUTH_SOCK);s.on('connect',()=>{s.destroy();r('OK')});s.on('error',e=>r(e.code))}) }))()`;
  const reg = await sb(w, code, { network: 'registries', args: [String(eph), p443 ? '1' : ''] });
  assert.equal(reg.eph, 'EPERM'); assert.equal(reg.listen, 'EPERM'); assert.equal(reg.ssh, 'EPERM'); assert.equal(reg.unix, 'OK');
  if (p443) assert.equal(reg.p443, 'EPERM', 'I2: loopback :443 must be denied in registries mode');
  assert.equal(reg.lo80, 'EPERM', 'I2: loopback :80 (EPERM, not ECONNREFUSED) must be denied'); assert.equal(reg.v6_443, 'EPERM');
  const none = await sb(w, code, { network: 'none', args: [String(eph), p443 ? '1' : ''] });
  assert.equal(none.eph, 'EPERM'); assert.equal(none.unix, 'EPERM'); assert.ok(['EPERM', 'skip'].includes(none.p443));
  assert.ok(['EPERM', 'none', 'ENOENT'].includes(none.agent) && reg.agent !== 'OK', 'ssh-agent socket reachable');
});

test('startSandboxed: the app listens on its port inside the sandbox, cannot write outside, and stopApp kills it', { skip: SKIP }, async (t) => {
  const w = world(t); const port = await freePort();
  const src = `const fs=require('fs');let w='EPERM';try{fs.writeFileSync(process.argv[1]+'/app.txt','x');w='OK'}catch{}
    require('http').createServer((q,s)=>s.end('write='+w)).listen(+process.env.PORT,'127.0.0.1',()=>console.log('ready'));`;
  const env = { ...P.allowEnv(null), PORT: String(port) };
  const app = S.startSandboxed(['node', '-e', src, w.outside], { cwd: w.work, env, profile: profileOf(w, { localhostPort: port }), tmpDir: w.tmpDir });
  t.after(() => P.stopApp(app, { graceMs: 500 }));
  assert.equal(await P.waitReady({ url: `http://127.0.0.1:${port}/`, timeout_s: 20 }, app), true, app.output());
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'write=EPERM');
  await P.stopApp(app, { graceMs: 500 });
  assert.equal(await P.portInUse(port), false);
});

// ---- fix round 1 regressions ----------------------------------------------------------------------------------------------------
// A FAKE home outside every other deny root (/private/tmp, not /private/tmp/claude-<uid> nor the user temp dir), so a hit proves the
// home rules themselves. Nothing is ever planted in the real home.
function fakeHome(t) {
  const h = fs.realpathSync(fs.mkdtempSync('/private/tmp/factory-fakehome-')); gone(t, h);
  const put = (rel, body = 'CRED\n') => { fs.mkdirSync(path.dirname(path.join(h, rel)), { recursive: true }); fs.writeFileSync(path.join(h, rel), body); };
  for (const f of ['.npmrc', '.codex/auth.json', '.docker/config.json', '.config/gcloud/credentials.db', '.zsh_history', '.python_history',
    'Library/Application Support/Google/Chrome/Default/Cookies', '.cargo/credentials.toml', '.kube/config', 'project/notes.txt', '.git-credentials']) put(f);
  put('.nvm/versions/node/v1/bin/tool.txt', 'TOOL\n');
  put('.nvm/.npmrc'); put('.local/share/pnpm/auth.json'); put('.nvm/versions/node/v1/etc/readme-not-a-cred.txt', 'OK\n');
  return h;
}

test('C1 sandbox fs: the whole home is unreadable except toolchains; credentials stay denied even inside an allowed toolchain dir', { skip: SKIP }, async (t) => {
  const w = world(t); const H = fakeHome(t);
  const prof = profileOf(w, 'none', { home: H, readAllow: [path.join(H, '.nvm'), path.join(H, '.cargo'), path.join(H, '.local/share/pnpm')] });
  const creds = ['.npmrc', '.codex/auth.json', '.docker/config.json', '.config/gcloud/credentials.db', '.zsh_history', '.python_history',
    'Library/Application Support/Google/Chrome/Default/Cookies', '.cargo/credentials.toml', '.kube/config', '.git-credentials', 'project/notes.txt',
    '.nvm/.npmrc', '.local/share/pnpm/auth.json'];
  const r = await sb(w, `const H=A[0],W=A[1];out({
    creds: JSON.parse(A[2]).map(c=>t(()=>fs.readFileSync(path.join(H,c),'utf8'))),
    listHome: t(()=>fs.readdirSync(H).join()), tool: t(()=>fs.readFileSync(path.join(H,'.nvm/versions/node/v1/bin/tool.txt'),'utf8')),
    listTool: t(()=>fs.readdirSync(path.join(H,'.nvm','versions')).join()), toolOther: t(()=>fs.readFileSync(path.join(H,'.nvm/versions/node/v1/etc/readme-not-a-cred.txt'),'utf8')),
    dotdot: t(()=>fs.readFileSync(path.join(H,'.nvm')+'/../.npmrc','utf8')),
    dotdotCargo: t(()=>fs.readFileSync(path.join(H,'.cargo')+'/../.npmrc','utf8')),
    symlink: t(()=>{fs.symlinkSync(path.join(H,'.npmrc'),path.join(W,'npmrc-link'));return fs.readFileSync(path.join(W,'npmrc-link'),'utf8')}),
    hardlink: t(()=>fs.linkSync(path.join(H,'project','notes.txt'),path.join(W,'hl'))),
    copy: t(()=>fs.copyFileSync(path.join(H,'.npmrc'),path.join(W,'cp'))),
    upper: t(()=>fs.readFileSync(path.join(H,'.NPMRC'),'utf8')), upperHome: t(()=>fs.readFileSync(H.toUpperCase()+'/.npmrc','utf8')),
    sysvol: t(()=>fs.readFileSync('/System/Volumes/Data'+H+'/.npmrc','utf8')),
    shell: t(()=>cp.execFileSync('/bin/sh',['-c','cat "$0"/.npmrc "$0"/.codex/auth.json 2>/dev/null; echo END',H],{encoding:'utf8'})),
  })`, { args: [H, w.work, JSON.stringify(creds)], profile: prof });
  assert.deepEqual(Object.fromEntries(creds.map((c, i) => [c, r.creds[i]])), Object.fromEntries(creds.map((c) => [c, 'EPERM'])));
  assert.deepEqual({ ...r, creds: undefined }, { creds: undefined, listHome: 'EPERM', tool: 'TOOL\n', listTool: 'node', toolOther: 'OK\n', dotdot: 'EPERM', dotdotCargo: 'EPERM',
    symlink: 'EPERM', hardlink: 'EPERM', copy: 'EPERM', upper: 'EPERM', upperHome: 'EPERM', sysvol: 'EPERM', shell: 'END\n' });
});

test('C1 sandbox fs: the real home, /Users (incl. /Users/Shared), the claude temp dir and the user temp dir are unreadable (no files planted)', { skip: SKIP }, async (t) => {
  const w = world(t);
  const claudeTmp = `/private/tmp/claude-${process.getuid()}`;
  const r = await sb(w, `out({ home: t(()=>fs.readdirSync(A[0]).length), users: t(()=>fs.readdirSync('/Users').length),
    shared: t(()=>fs.readdirSync('/Users/Shared').length), claude: t(()=>fs.readdirSync(A[1]).length), userTmp: t(()=>fs.readdirSync(A[2]).length),
    gitconfig: t(()=>fs.readFileSync(path.join(A[0],'.gitconfig'),'utf8').length) })`, { args: [os.userInfo().homedir, claudeTmp, os.tmpdir()] });
  assert.equal(r.home, 'EPERM'); assert.equal(r.users, 'EPERM'); assert.equal(r.userTmp, 'EPERM');
  assert.ok(['EPERM', 'ENOENT'].includes(r.shared)); assert.ok(['EPERM', 'ENOENT'].includes(r.gitconfig));
  assert.equal(r.claude, fs.existsSync(claudeTmp) ? 'EPERM' : 'ENOENT');
});

test('C1 homeDirs: os.userInfo().homedir AND $HOME when they differ; defaultReadDeny takes a home param', () => {
  const real = fs.realpathSync(os.userInfo().homedir);
  assert.deepEqual(S.homeDirs({ HOME: '/private/tmp' }), [real, '/private/tmp']);
  assert.deepEqual(S.homeDirs({ HOME: os.userInfo().homedir }), [real]);
  assert.deepEqual(S.homeDirs({}), [real]);
  const d = S.defaultReadDeny('/h/x', '/fh');
  assert.equal(d[0], '/fh'); assert.ok(d.includes('/h/x/.npmrc') && d.includes('/h/x/.codex') && d.includes('/h/x/Library/Application Support'));
});

test('I1 sandbox: processes outside the sandbox (the driver, a victim) cannot be signalled or inspected; own children can', { skip: SKIP }, async (t) => {
  const w = world(t);
  const victim = spawn('/bin/sleep', ['120'], { env: { PATH: '/usr/bin:/bin', SBX_SENTINEL: 'tok_SENTINEL_ENV_42' }, detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(victim.pid, 'SIGKILL'); } catch { /* gone */ } });
  await new Promise((res) => setTimeout(res, 200));
  const py = 'import ctypes,sys\nlibc=ctypes.CDLL(None)\nmib=(ctypes.c_int*3)(1,49,int(sys.argv[1]))\nn=ctypes.c_size_t(1<<20);b=ctypes.create_string_buffer(1<<20)\nlibc.sysctl(mib,3,b,ctypes.byref(n),None,0)\nprint("FOUND" if b"tok_SENTINEL_ENV_42" in b.raw[:n.value] else "no")';
  fs.writeFileSync(path.join(w.tmpDir, 'procargs.py'), py);
  const r = await sb(w, `const V=+A[0];const sh=(c)=>{try{return cp.execFileSync('/bin/sh',['-c',c],{encoding:'utf8',stdio:['ignore','pipe','ignore']})}catch(e){return String(e.stdout||'')}};
    const child=cp.spawn('/bin/sleep',['30']);
    out({ kill9: t(()=>process.kill(V,'SIGKILL')), stop: t(()=>process.kill(V,'SIGSTOP')), usr1: t(()=>process.kill(V,'SIGUSR1')),
      parent: t(()=>process.kill(process.ppid,'SIGCONT')), pkill: sh('pkill -9 -f "sleep 120"; echo rc=$?').trim()!=='rc=0',
      psEnv: /tok_SENTINEL/.test(sh('ps eww -p '+V+' -o command=')), psAll: sh('ps -axww -o pid=').trim().split(/\\s+/).includes(String(V)),
      lsof: sh('lsof -p '+V+' 2>/dev/null | wc -l').trim(), procargs: sh('/usr/bin/python3 -I "$TMPDIR/procargs.py" '+V).trim(),
      ownChild: t(()=>{process.kill(child.pid,'SIGKILL')}) })`, { args: [String(victim.pid), py] });
  assert.deepEqual(r, { kill9: 'EPERM', stop: 'EPERM', usr1: 'EPERM', parent: 'EPERM', pkill: true, psEnv: false, psAll: false, lsof: '0', procargs: 'no', ownChild: 'OK' });
  assert.doesNotThrow(() => process.kill(victim.pid, 0), 'the victim must still be alive');
});

test('I5 sandboxProfile: writable dirs must be under FACTORY_HOME/work or FACTORY_HOME/tmp (by realpath and inode)', (t) => {
  const root = tmp(t); const fh = path.join(root, 'fh');
  for (const d of ['work/wt', 'tmp/run', 'scenarios']) fs.mkdirSync(path.join(fh, d), { recursive: true });
  fs.symlinkSync(root, path.join(fh, 'work', 'escape'));
  const P0 = (writable) => S.sandboxProfile({ writable, network: 'none', factoryHome: fh, readAllow: [] });
  assert.ok(P0([path.join(fh, 'work', 'wt'), path.join(fh, 'tmp', 'run')]).includes(`(subpath "${fh}/work/wt")`));
  for (const bad of [fh, path.join(fh, 'work'), path.join(fh, 'tmp'), path.join(fh, 'scenarios'), path.join(fh, 'work', 'escape'), root, '/private/tmp']) {
    assert.throws(() => P0([bad]), /must be inside|contains protected path/, bad);
  }
  for (const real of [path.join(os.homedir(), 'workspace'), path.join(os.homedir(), 'Library', 'LaunchAgents')]) {
    if (fs.existsSync(real)) assert.throws(() => S.sandboxProfile({ writable: [real], network: 'none', factoryHome: fh, readAllow: [] }), /must be inside/, real);
  }
  assert.doesNotThrow(() => S.sandboxProfile({ writable: [root + '/fh/scenarios'], network: 'none', factoryHome: path.join(root, 'other'), readAllow: [], unsafeAllowOutsideFactoryHome: true }));
});

test('tmpDir is derived once from the profile: a different tmpDir is refused; TMPDIR and HOME point into the run temp', { skip: SKIP }, async (t) => {
  const w = world(t); const other = S.makeRunTemp(w.fh); t.after(() => S.removeRunTemp(other));
  await assert.rejects(S.runSandboxed(['/usr/bin/true'], { profile: profileOf(w), tmpDir: other }), /does not match/);
  const r = await sb(w, `out({ tmp: os.tmpdir(), home: os.homedir() })`, { profile: profileOf(w) });
  assert.deepEqual(r, { tmp: w.tmpDir, home: path.join(w.tmpDir, 'home') });
});

// ---- C2: gitSafe config allowlist ---------------------------------------------------------------------------------------------
function hostileRepo(t) {
  const repo = repoWithCommit(t); const mk = (n) => path.join(repo, `${n}-RAN`);
  const script = (n) => { const f = path.join(repo, `${n}.sh`); fs.writeFileSync(f, `#!/bin/sh\ntouch "${mk(n)}"\ncat\n`, { mode: 0o755 }); return f; };
  return { repo, mk, script };
}

test('C2 gitSafe: a planted filter.*.smudge selected by .gitattributes makes checkout THROW and never runs', (t) => {
  const { repo, mk, script } = hostileRepo(t);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=x\n');
  git(repo, 'add', '.gitattributes'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'attrs');
  git(repo, 'config', 'filter.x.smudge', script('smudge')); git(repo, 'config', 'filter.x.clean', script('clean'));
  fs.rmSync(path.join(repo, 'a.txt'));
  assert.throws(() => G.gitSafe(repo, 'checkout', '--', 'a.txt'), (e) => e.message === 'git config not allowed: filter.x.smudge');
  assert.throws(() => G.gitSafe(repo, 'status'), /git config not allowed: filter\.x\./);
  assert.equal(fs.existsSync(mk('smudge')) || fs.existsSync(mk('clean')), false);
  git(repo, 'checkout', '--', 'a.txt'); // control: plain git runs the smudge filter
  assert.equal(fs.existsSync(mk('smudge')), true, 'control: plain git should run the planted smudge filter');
});

test('C2 gitSafe: textconv (via blame), merge drivers, uploadpack, includes, url rewrites and unsafe remote URLs all throw before running', (t) => {
  const cases = [
    ['diff.conv.textconv', (s) => s('textconv'), ['blame', 'a.txt'], (repo) => fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt diff=conv\n')],
    ['merge.evil.driver', (s) => `${s('merge')} %O %A %B`, ['merge', '--ff-only', 'other']],
    ['remote.up.uploadpack', (s) => s('uploadpack'), ['fetch', 'up']],
    ['include.path', () => '/dev/null', ['status']],
    ['url.ext::sh.insteadof', () => 'https://', ['status']],
    ['core.editor', (s) => s('editor'), ['commit', '--allow-empty']],
    ['gpg.program', (s) => s('gpg'), ['status']],
    ['credential.helper', (s) => `!${s('cred')}`, ['status']],
    ['alias.st', () => '!touch PWN', ['st']],
    ['core.hookspath', () => '.githooks', ['status']],
    ['remote.origin.url', () => 'ext::sh -c touch% PWN', ['status']],
    ['remote.origin.url', () => '/tmp/some/local.git', ['status']],
  ];
  for (const [key, val, cmd, extra] of cases) {
    const { repo, mk, script } = hostileRepo(t);
    git(repo, 'config', key, val(script));
    if (key === 'remote.up.uploadpack') git(repo, 'config', 'remote.up.url', 'https://example.invalid/x.git');
    extra?.(repo);
    assert.throws(() => G.gitSafe(repo, ...cmd), (e) => e.message.toLowerCase() === `git config not allowed: ${key}`.toLowerCase(), key);
    assert.deepEqual(fs.readdirSync(repo).filter((f) => f.endsWith('-RAN') || f === 'PWN'), [], `${key} ran`);
    assert.ok(!/touch|sh -c|\.sh/.test(String((() => { try { G.gitSafe(repo, ...cmd); } catch (e) { return e.message; } })())), 'the error names the key only, never the value');
  }
});

test('C2 gitSafe: a clean repo with an https remote and branch tracking is allowed; caller -c and global options are checked', (t) => {
  const repo = repoWithCommit(t); const other = repoWithCommit(t);
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git'); git(repo, 'config', 'branch.main.remote', 'origin'); git(repo, 'config', 'branch.main.merge', 'refs/heads/main');
  git(repo, 'config', 'user.name', 'Driver'); git(repo, 'config', 'gc.auto', '0'); git(repo, 'config', 'remote.ssh.url', 'git@github.com:example/repo.git');
  assert.equal(G.gitSafe(repo, 'status', '--porcelain').code, 0);
  assert.equal(G.gitSafe(repo, '-c', 'user.name=x', '-c', 'user.email=x@y', 'commit', '-q', '--allow-empty', '-m', 'ok').code, 0);
  assert.throws(() => G.gitSafe(repo, '-c', 'filter.x.smudge=touch PWN', 'status'), /^Error: git config not allowed: filter\.x\.smudge$/);
  assert.throws(() => G.gitSafe(repo, '--exec-path=/tmp', 'status'), /global option not allowed: --exec-path/);
  assert.throws(() => G.gitSafe(repo, '--config-env', 'core.pager=X', 'status'), /global option not allowed/);
  git(other, 'config', 'core.fsmonitor', '/bin/echo');
  assert.throws(() => G.gitSafe(repo, '-C', other, 'status'), /git config not allowed: core\.fsmonitor/, '-C must verify the repository it points at');
  assert.throws(() => G.gitSafe(repo, '--git-dir', path.join(other, '.git'), 'status'), /core\.fsmonitor/);
  for (const [k, v, ok] of [['remote.o.url', 'https://h.example/x', true], ['remote.o.url', 'git@h.example:a/b', true], ['remote.o.url', 'file:///x', false],
    ['remote.o.url', '-oProxyCommand=x@h:p', false], ['remote.o.pushurl', 'ext::x', false], ['branch.m.remote', 'https://h/x', false], ['remote.o.fetch', '-x', false],
    ['Core.FileMode', 'true', true], ['core.worktree', '/x', false], ['core.sparsecheckout', 'true', false], ['extensions.worktreeconfig', 'true', true],
    ['gc.auto', '0', true], ['gc.somehook', 'x', false], ['pack.island', 'x', false], ['advice.detachedhead', 'false', false], ['foo.hook', 'x', false],
    ['remote.o.hooks', 'x', false], ['extensions.partialclone', 'o', false], ['remote.o.vcs', 'x', false], ['remote.o.promisor', 'true', false], ['remote.o.receivepack', 'x', false],
    ['safe.directory', '*', false], ['http.proxy', 'x', false], ['protocol.allow', 'always', false], ['commit.gpgsign', 'true', false]]) {
    assert.equal(G.configAllowed(k, v), ok, `${k}=${v}`);
  }
});

test('I3/I4 gitSafe: timeout and signal deaths THROW without output; a timeout option is separate from git args', (t) => {
  const repo = repoWithCommit(t);
  assert.throws(() => G.gitSafeOpts(repo, ['log'], { timeout: 1 }), /timed out after 1 ms|killed by SIGKILL/);
  assert.equal(G.gitSafeOpts(repo, ['rev-parse', 'HEAD'], { timeout: 20000 }).code, 0);
  assert.throws(() => G.gitSafeOpts(repo, 'log'), /args must be an array/);
});

// ---- addendum: exact allowlist, core.worktree, and the second-layer -c flags (each proven with verified:true) ------------------
test('C2 addendum: a planted core.worktree makes gitSafe throw and nothing is written to the redirected tree', (t) => {
  const repo = repoWithCommit(t); const elsewhere = tmp(t, 'factory-elsewhere-');
  git(repo, 'config', 'core.worktree', elsewhere);
  assert.throws(() => G.gitSafe(repo, 'checkout', '-f', 'other'), /^Error: git config not allowed: core\.worktree$/);
  assert.throws(() => G.gitSafe(repo, 'reset', '--hard'), /core\.worktree/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('C2 addendum: the allowlist accepts exactly what a driver-created clone and worktree contain', (t) => {
  const src = repoWithCommit(t); const d = tmp(t, 'factory-clone-');
  const clone = path.join(d, 'clone'); spawnSync('git', ['clone', '-q', src, clone], { env: G.gitEnv() });
  git(clone, 'config', 'remote.origin.url', 'https://github.com/example/repo.git'); // the driver's clone has an https origin
  git(clone, 'config', 'extensions.worktreeConfig', 'true');
  assert.equal(G.gitSafe(clone, 'worktree', 'add', '-q', path.join(d, 'wt'), '-b', 'feat').code, 0);
  for (const r of [clone, path.join(d, 'wt')]) assert.equal(G.gitSafe(r, 'status', '--porcelain').code, 0);
  git(clone, 'config', 'gc.auto', '0'); assert.equal(G.gitSafe(clone, 'status').code, 0);
  git(clone, 'config', 'pack.threads', '1'); assert.throws(() => G.gitSafe(clone, 'status'), /not allowed: pack\.threads/);
});

function planted(t) {
  const repo = repoWithCommit(t); const mk = (n) => path.join(repo, `${n}-RAN`);
  const script = (n, tail = '') => { const f = path.join(repo, `${n}.sh`); fs.writeFileSync(f, `#!/bin/sh\ntouch "${mk(n)}"\n${tail}`, { mode: 0o755 }); return f; };
  git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'user.email', 't@e');
  return { repo, mk, script, v: { verified: true } };
}
const ran = (mk, n) => fs.existsSync(mk(n));

test('second layer: core.editor / sequence.editor never run (commit without -m, rebase -i)', (t) => {
  const { repo, mk, script, v } = planted(t);
  git(repo, 'config', 'core.editor', script('editor')); git(repo, 'config', 'sequence.editor', script('seq'));
  G.gitSafeOpts(repo, ['commit', '--allow-empty'], v);
  G.gitSafeOpts(repo, ['rebase', '-i', 'HEAD'], v);
  assert.equal(ran(mk, 'editor') || ran(mk, 'seq'), false);
  spawnSync('git', ['commit', '--allow-empty'], { cwd: repo, env: G.gitEnv(), stdio: 'ignore' });
  assert.equal(ran(mk, 'editor'), true, 'control: plain git runs core.editor');
});

test('second layer: gpg.program never runs even with commit.gpgSign=true', (t) => {
  const { repo, mk, script, v } = planted(t);
  git(repo, 'config', 'gpg.program', script('gpg', 'exit 1\n')); git(repo, 'config', 'commit.gpgSign', 'true');
  assert.equal(G.gitSafeOpts(repo, ['commit', '-q', '--allow-empty', '-m', 'x'], v).code, 0);
  assert.equal(ran(mk, 'gpg'), false);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'y');
  assert.equal(ran(mk, 'gpg'), true, 'control: plain git runs gpg.program');
});

test('second layer: credential.helper and core.askPass never run on an HTTP 401', async (t) => {
  const { repo, mk, script, v } = planted(t);
  git(repo, 'config', 'credential.helper', `!${script('cred')}`); git(repo, 'config', 'core.askPass', script('askpass'));
  const srv = spawn(process.execPath, ['-e', "require('http').createServer((q,s)=>{s.writeHead(401,{'WWW-Authenticate':'Basic realm=x'});s.end()}).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => srv.kill('SIGKILL'));
  const port = await new Promise((res) => srv.stdout.once('data', (d) => res(String(d).trim())));
  const r = G.gitSafeOpts(repo, ['ls-remote', `http://127.0.0.1:${port}/x.git`], { ...v, timeout: 20000, unsafeAllowLocalUrls: true });
  assert.notEqual(r.code, 0);
  assert.equal(ran(mk, 'cred') || ran(mk, 'askpass'), false);
  spawnSync('git', ['ls-remote', `http://127.0.0.1:${port}/x.git`], { cwd: repo, env: G.gitEnv(), stdio: 'ignore', timeout: 20000 });
  assert.equal(ran(mk, 'cred') || ran(mk, 'askpass'), true, 'control: plain git runs the credential helper / askpass');
});

test('second layer: core.attributesFile cannot select a clean filter; core.excludesFile cannot hide files', (t) => {
  const { repo, mk, script, v } = planted(t);
  const attrs = path.join(repo, 'attrs'); fs.writeFileSync(attrs, '*.txt filter=x\n');
  git(repo, 'config', 'core.attributesFile', attrs); git(repo, 'config', 'filter.x.clean', script('clean', 'cat\n'));
  const excl = path.join(repo, 'excl'); fs.writeFileSync(excl, 'hidden.txt\n'); git(repo, 'config', 'core.excludesFile', excl);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n'); fs.writeFileSync(path.join(repo, 'hidden.txt'), 'h\n');
  G.gitSafeOpts(repo, ['add', 'a.txt'], v);
  assert.equal(ran(mk, 'clean'), false);
  assert.match(G.gitSafeOpts(repo, ['status', '--porcelain'], v).out, /\?\? hidden\.txt/);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed again for the control\n'); // new content: git cannot skip the filter via the stat cache
  git(repo, 'add', 'a.txt');
  assert.equal(ran(mk, 'clean'), true, 'control: plain git runs the clean filter selected by core.attributesFile');
});

test('second layer: gc.auto=0 keeps auto-gc from running inside a driver call', (t) => {
  const { repo, v } = planted(t);
  git(repo, 'config', 'gc.auto', '1'); git(repo, 'config', 'gc.autoDetach', 'false');
  // auto-gc samples objects/17: ~1500 loose blobs put several there, so plain git reliably decides to gc.
  for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(repo, `f${i}`), `${i}\n`);
  git(repo, 'add', '.');
  const packs = () => fs.readdirSync(path.join(repo, '.git', 'objects', 'pack')).filter((f) => f.endsWith('.pack')).length;
  G.gitSafeOpts(repo, ['commit', '-q', '-m', 'many'], v);
  assert.equal(packs(), 0, 'auto-gc packed objects inside a gitSafe call');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'ctl');
  assert.ok(packs() > 0, 'control: plain git auto-gc packs with gc.auto=1');
});

// ---- fix round 2 ------------------------------------------------------------------------------------------------------------------
// N1: kern.procargs2 is a sysctl, not process-info: it returned the argv AND environment of every same-user process (the driver too).
const PROCARGS_PY = `import ctypes,sys,os
libc=ctypes.CDLL(None)
def pa(pid):
  mib=(ctypes.c_int*3)(1,49,pid); n=ctypes.c_size_t(1<<17); b=ctypes.create_string_buffer(1<<17)
  rc=libc.sysctl(mib,3,b,ctypes.byref(n),None,0)
  return rc, (b.raw[:n.value] if rc==0 else b'')
mode=sys.argv[1]
if mode=='one':
  rc,d=pa(int(sys.argv[2])); print(rc, sys.argv[3].encode() in d)
elif mode=='scan':
  # processes in THIS sandbox (the sh and its subshells) carry SELF_SENTINEL and are allowed; count every other readable one
  seen=0
  for pid in range(1,100000):
    rc,d=pa(pid)
    if rc==0 and len(d)>4 and b'SELF_SENTINEL=tok_SELF' not in d:
      seen+=1
  print(seen)
elif mode=='all':
  m=(ctypes.c_int*4)(1,14,0,0); n=ctypes.c_size_t(0); print(libc.sysctl(m,3,None,ctypes.byref(n),None,0))`;

test('N1 sandbox: no other process\'s argv/environment via kern.procargs2 (the driver, a node victim, a scan); its own stays readable', { skip: SKIP }, async (t) => {
  const w = world(t);
  const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: { ...process.env, DRIVER_SECRET_SENTINEL: 'tok_N1_SENTINEL' }, stdio: 'ignore' });
  t.after(() => victim.kill('SIGKILL'));
  await new Promise((res) => setTimeout(res, 300));
  // Control: outside the sandbox the victim's environment IS readable this way, so the probe is not a false negative.
  fs.writeFileSync(path.join(w.tmpDir, 'pa.py'), PROCARGS_PY);
  assert.match(spawnSync('/usr/bin/python3', ['-I', path.join(w.tmpDir, 'pa.py'), 'one', String(victim.pid), 'tok_N1_SENTINEL'], { encoding: 'utf8' }).stdout, /^0 True/);
  const file = path.join(w.tmpDir, 'n1.json');
  const env = { ...P.allowEnv(null), SELF_SENTINEL: 'tok_SELF', OUT: file };
  const r = await S.runSandboxed(['/bin/sh', '-c', `py() { /usr/bin/python3 -I "$TMPDIR/pa.py" "$@" 2>/dev/null; }
    printf '{"victim":"%s","parent":"%s","self":"%s","scan":"%s","all":"%s"}' "$(py one ${victim.pid} tok_N1_SENTINEL)" "$(py one $PPID PATH=)" "$(py one $$ SELF_SENTINEL=tok_SELF)" "$(py scan)" "$(py all)" > "$OUT"`],
  { cwd: w.work, env, profile: profileOf(w), timeoutS: 120 });
  const o = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(o, { victim: '-1 False', parent: '-1 False', self: '0 True', scan: '0', all: '-1' }, r.tail);
});

test('N2 sandbox fs: credential-named files inside default toolchain dirs (incl. case variants) are unreadable; .local/bin is no longer allowed', { skip: SKIP }, async (t) => {
  const w = world(t); const H = fakeHome(t);
  const put = (rel, body = 'CRED\n') => { fs.mkdirSync(path.dirname(path.join(H, rel)), { recursive: true }); fs.writeFileSync(path.join(H, rel), body); return rel; };
  const creds = ['.nvm/versions/node/v1/etc/npmrc', '.nvm/versions/node/v1/lib/node_modules/x/.npmrc', '.cargo/registry/index/x/credentials.toml',
    '.volta/tools/image/x/auth.json', '.local/share/pnpm/rc', '.local/share/pnpm/auth.ini', '.pyenv/pip.conf', '.pyenv/pip.ini', '.bun/bunfig.toml',
    '.bun/install/global/.npmrc', '.asdf/.env', '.asdf/.env.local', '.asdf/.env.production', '.volta/credentials', '.volta/credentials.json',
    '.nvm/_netrc', '.nvm/.netrc', '.nvm/versions/node/v1/etc/NPMRC', '.pyenv/Pip.Conf', '.nvm/versions/node/v1/lib/node_modules/x/npmrc.bak',
    '.nvm/x/.npmrc.orig', '.nvm/x/credentials.toml~', '.nvm/x/.env.swp', '.nvm/x/auth.json.old', '.rustup/id_ed25519', '.rustup/ID_RSA', '.nvm/x/.yarnrc.yml',
    '.nvm/x/.git-credentials', '.nvm/x/.pypirc', '.local/bin/deploy.sh'].map((c) => put(c));
  put('.nvm/versions/node/v1/lib/node_modules/x/index.js', 'module.exports=1\n');
  const r = await sb(w, `out({ creds: JSON.parse(A[1]).map(c=>t(()=>fs.readFileSync(path.join(A[0],c),'utf8'))),
    ok: t(()=>fs.readFileSync(path.join(A[0],'.nvm/versions/node/v1/lib/node_modules/x/index.js'),'utf8')) })`,
  { args: [H, JSON.stringify(creds)], profile: profileOf(w, 'none', { home: H }) });
  assert.deepEqual(Object.fromEntries(creds.map((c, i) => [c, r.creds[i]])), Object.fromEntries(creds.map((c) => [c, 'EPERM'])));
  assert.equal(r.ok, 'module.exports=1\n');
  assert.ok(!S.TOOLCHAIN_PATHS.includes('.local/bin'));
});

test('N2 node read paths: a toolchain or system prefix is allowed whole; a prefix elsewhere under a home allows only node, npm and corepack', (t) => {
  const H = fs.realpathSync(fs.mkdtempSync('/private/tmp/factory-nodehome-')); gone(t, H);
  const mk = (prefix) => { for (const d of ['bin', 'lib/node_modules/npm', 'lib/node_modules/corepack', 'etc']) fs.mkdirSync(path.join(prefix, d), { recursive: true }); fs.writeFileSync(path.join(prefix, 'bin', 'node'), ''); return path.join(prefix, 'bin', 'node'); };
  const odd = mk(path.join(H, 'opt', 'node')); fs.writeFileSync(path.join(H, 'opt/node/lib/libnode.147.dylib'), ''); fs.writeFileSync(path.join(H, 'opt/node/lib/other.txt'), ''); const nvm = mk(path.join(H, '.nvm', 'versions', 'node', 'v1'));
  const sys = mk(fs.realpathSync(fs.mkdtempSync('/private/tmp/factory-sysnode-'))); gone(t, path.dirname(path.dirname(sys)));
  const roots = [H];
  const a = S.nodeReadPaths({ nodePaths: [odd], homes: [H], denyRoots: roots });
  assert.deepEqual(a, { subpaths: [path.join(H, 'opt/node/lib/node_modules/npm'), path.join(H, 'opt/node/lib/node_modules/corepack')],
    literals: [...['node', 'npm', 'npx', 'corepack'].map((b) => path.join(H, 'opt/node/bin', b)), path.join(H, 'opt/node/lib/libnode.147.dylib')] });
  assert.deepEqual(S.nodeReadPaths({ nodePaths: [nvm], homes: [H], denyRoots: roots }), { subpaths: [path.join(H, '.nvm/versions/node/v1')], literals: [] });
  assert.deepEqual(S.nodeReadPaths({ nodePaths: [sys], homes: [H], denyRoots: roots }), { subpaths: [path.dirname(path.dirname(sys))], literals: [] });
});

test('N2 sandbox fs: an odd node prefix under home exposes only node/npm/corepack, and never credential names', { skip: SKIP }, async (t) => {
  const w = world(t); const H = fakeHome(t);
  const pre = path.join(H, 'opt', 'node');
  for (const d of ['bin', 'lib/node_modules/npm', 'lib/node_modules/corepack', 'lib/node_modules/other', 'etc']) fs.mkdirSync(path.join(pre, d), { recursive: true });
  for (const [f, b] of [['bin/node', 'BIN'], ['lib/node_modules/npm/package.json', 'NPM'], ['lib/node_modules/npm/.npmrc', 'CRED'], ['lib/node_modules/other/x', 'OTHER'], ['etc/npmrc', 'CRED'], ['secret.txt', 'S']]) fs.writeFileSync(path.join(pre, f), b);
  const prof = profileOf(w, 'none', { home: H, nodePaths: [path.join(pre, 'bin', 'node')] });
  const r = await sb(w, `out(JSON.parse(A[1]).map(f=>t(()=>fs.readFileSync(path.join(A[0],f),'utf8'))))`,
    { args: [pre, JSON.stringify(['bin/node', 'lib/node_modules/npm/package.json', 'lib/node_modules/npm/.npmrc', 'lib/node_modules/other/x', 'etc/npmrc', 'secret.txt'])], profile: prof });
  assert.deepEqual(r, ['BIN', 'NPM', 'EPERM', 'EPERM', 'EPERM', 'EPERM']);
});

test('minor gitSafe: remote URLs to loopback, private, link-local or numeric-IP hosts are refused (driver-side SSRF)', () => {
  for (const u of ['https://127.0.0.1/x', 'https://localhost/x', 'https://a.localhost/x', 'https://10.0.0.1/x', 'https://172.16.5.4/x', 'https://172.31.0.1/x',
    'https://192.168.1.1/x', 'https://169.254.169.254/x', 'https://0.0.0.0/x', 'https://[::1]/x', 'https://[fe80::1]/x', 'https://[fd00::1]/x', 'https://2130706433/x',
    'https://0x7f000001/x', 'https://0177.0.0.1/x', 'https://8.8.8.8/x', 'ssh://git@127.0.0.1/x', 'git@10.1.2.3:a/b', 'git@localhost:a/b', 'https://LOCALHOST/x', 'https://127.1/x']) {
    assert.equal(G.configAllowed('remote.origin.url', u), false, u);
  }
  for (const u of ['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@gitlab.example.com/a/b', 'https://172.example.com/x']) assert.equal(G.configAllowed('remote.origin.url', u), true, u);
});

test('minor gitSafe: replace refs are ignored (GIT_NO_REPLACE_OBJECTS)', (t) => {
  const repo = repoWithCommit(t);
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'REAL');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'FAKE');
  const real = git(repo, 'rev-parse', 'HEAD~1').stdout.trim(); const fake = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  git(repo, 'reset', '-q', '--hard', 'HEAD~1'); git(repo, 'replace', real, fake);
  const plainEnv = G.gitEnv(); delete plainEnv.GIT_NO_REPLACE_OBJECTS;
  assert.match(spawnSync('git', ['log', '-1', '--format=%s'], { cwd: repo, env: plainEnv, encoding: 'utf8' }).stdout, /FAKE/, 'control: plain git honours the replace ref');
  assert.equal(G.gitSafe(repo, 'log', '-1', '--format=%s').out, 'REAL\n');
});

test('minor gitSafe: git killed by an outside signal (no timeout, no error) throws without output', async (t) => {
  const repo = repoWithCommit(t);
  const srv = spawn(process.execPath, ['-e', "require('net').createServer(()=>{}).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => srv.kill('SIGKILL'));
  const port = await new Promise((res) => srv.stdout.once('data', (d) => res(String(d).trim())));
  // Kill git AND its git-remote-http children (they hold the pipes); the sh's own command line does not contain the full pattern.
  const tag = `sigprobe${rnd()}`;
  const killer = spawn('/bin/sh', ['-c', `p=127.0.0.1:${port}; sleep 1; pkill -KILL -f "$p/${tag}"`], { stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-killer.pid, 'SIGKILL'); } catch { /* done */ } });
  assert.throws(() => G.gitSafeOpts(repo, ['ls-remote', `http://127.0.0.1:${port}/${tag}`], { timeout: 30000, unsafeAllowLocalUrls: true }), /^Error: git ls-remote was killed by SIGKILL$/);
});

// ---- fix round 3: exact credential names (no prefix patterns), near-miss readability, real toolchain layouts ---------------------
const NEAR_MISS = ['.envrc', '.envX', '.environment', '.env-prod', 'environment.js', 'tokenize.js', 'tokenizer.js', 'token.js', 'tokens.js', 'token.rs', 'token.py',
  'tokenize.py', 'tokens/list.js', 'token/index.js', 'rc', 'rc.js', 'rcfile', 'rcedit', 'node_modules/rc/index.js', 'credentialsX', 'credentials-foo', 'npmrcX',
  'npmrc-backup', 'id_rsa_tool.js', 'id_rsa.pub', 'id_x/y.js', 'cert.pem', 'cacert.pem', 'certifi/cacert.pem', 'ca-bundle.crt', 'credentials.js', 'lib/credentials.js', 'a.keys',
  'keyboard.pem.js', 'x.key/inner.txt', 'pubkey.pem', 'token.jsonx', 'mytoken.json', 'pip.config', 'auth.json.d/x', '.env/x', 'credentials/inner.txt',
  'npmrc.bak.js', 'monkey', 'x-y.z~', 'xnpmrc', 'pipXconf', 'id_rsaXbak', '_env'];

test('R3 sandbox fs: near-miss names in toolchain dirs stay READABLE; directories named like credentials stay usable', { skip: SKIP }, async (t) => {
  const w = world(t); const H = fakeHome(t);
  for (const n of NEAR_MISS) { const f = path.join(H, '.nvm/x', n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'S'); }
  const r = await sb(w, `out({ reads: JSON.parse(A[1]).map(n=>t(()=>fs.readFileSync(path.join(A[0],n),'utf8'))),
    statRc: t(()=>fs.statSync(path.join(A[0],'node_modules/rc')).isDirectory()), listCred: t(()=>fs.readdirSync(path.join(A[0],'credentials')).join()) })`,
  { args: [path.join(H, '.nvm/x'), JSON.stringify(NEAR_MISS)], profile: profileOf(w, 'none', { home: H }) });
  assert.deepEqual(Object.fromEntries(NEAR_MISS.map((n, i) => [n, r.reads[i]])), Object.fromEntries(NEAR_MISS.map((n) => [n, 'S'])));
  assert.equal(r.statRc, true); assert.equal(r.listCred, 'inner.txt');
});

test('R3 sandbox fs: real toolchain layouts work (nvm npm tokenize.js via require, cargo syn token.rs, pyenv token.py/tokenize.py)', { skip: SKIP }, async (t) => {
  const w = world(t); const H = fakeHome(t);
  const put = (rel, body) => { const f = path.join(H, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  const tok = put('.nvm/versions/node/v20.0.0/lib/node_modules/npm/node_modules/postcss-selector-parser/dist/tokenize.js', 'module.exports = "TOKENIZE";\n');
  put('.nvm/versions/node/v20.0.0/lib/node_modules/npm/lib/commands/token.js', 'module.exports = "TOKENCMD";\n');
  const rs = put('.cargo/registry/src/index.crates.io-6f17d22bba15001f/syn-2.0.87/src/token.rs', '// token.rs\n');
  const py = put('.pyenv/versions/3.12.1/lib/python3.12/token.py', '# token\n'); const py2 = put('.pyenv/versions/3.12.1/lib/python3.12/tokenize.py', '# tokenize\n');
  const cred = put('.nvm/versions/node/v20.0.0/etc/npmrc', '//r/:_authToken=FAKE\n');
  const r = await sb(w, `out({ req: t(()=>require(A[0])), cmd: t(()=>require(A[1])), rs: t(()=>fs.readFileSync(A[2],'utf8')), py: t(()=>fs.readFileSync(A[3],'utf8')),
    py2: t(()=>fs.readFileSync(A[4],'utf8')), cred: t(()=>fs.readFileSync(A[5],'utf8')) })`,
  { args: [tok, tok.replace(/node_modules\/postcss-selector-parser\/dist\/tokenize\.js$/, 'lib/commands/token.js'), rs, py, py2, cred], profile: profileOf(w, 'none', { home: H }) });
  assert.deepEqual(r, { req: 'TOKENIZE', cmd: 'TOKENCMD', rs: '// token.rs\n', py: '# token\n', py2: '# tokenize\n', cred: 'EPERM' });
});

const NVM_NODE = (() => { try { const d = path.join(os.userInfo().homedir, '.nvm', 'versions', 'node'); const v = fs.readdirSync(d).sort().pop(); const n = path.join(d, v, 'bin', 'node'); return fs.existsSync(n) ? n : null; } catch { return null; } })();
test('R3 sandbox: the real ~/.nvm node runs npm (npm ls / install of a local package) inside the sandbox (read-only use of the real home)', { skip: SKIP || (!NVM_NODE && 'no ~/.nvm node installed') }, async (t) => {
  const w = world(t);
  const dep = path.join(w.work, 'dep'); fs.mkdirSync(path.join(dep, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', main: 'lib/tokenize.js' }));
  fs.writeFileSync(path.join(dep, 'lib', 'tokenize.js'), 'module.exports = "DEP-TOKENIZE";\n');
  fs.writeFileSync(path.join(w.work, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { dep: 'file:./dep' } }));
  const npmCli = path.join(path.dirname(path.dirname(NVM_NODE)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const env = { ...P.allowEnv(null), PATH: `${path.dirname(NVM_NODE)}:/usr/bin:/bin`, npm_config_cache: path.join(w.tmpDir, 'npm-cache'), npm_config_update_notifier: 'false' };
  const prof = profileOf(w, 'none', { nodePaths: [NVM_NODE] });
  const i = await S.runSandboxed([NVM_NODE, npmCli, 'install', '--no-audit', '--no-fund', '--offline'], { cwd: w.work, env, profile: prof, timeoutS: 120 });
  assert.equal(i.code, 0, i.tail);
  const l = await S.runSandboxed([NVM_NODE, npmCli, 'ls'], { cwd: w.work, env, profile: prof, timeoutS: 60 });
  assert.equal(l.code, 0, l.tail);
  const q = await S.runSandboxed([NVM_NODE, '-e', 'process.exit(require("dep")==="DEP-TOKENIZE"?0:3)'], { cwd: w.work, env, profile: prof, timeoutS: 30 });
  assert.equal(q.code, 0, q.tail);
});

test('R3 credential-name regex text: exact names, suffix forms, letter ranges folded (case-sensitive check of the generated text)', () => {
  const bodies = S.credNameRegexBodies('/h/.nvm');
  for (const body of bodies) {
    assert.ok(!/\[[^\]]*-\]/.test(body), 'no trailing-dash class (SBPL misparses it)');
    assert.ok(body.length < 1000, 'SBPL string literal limit');
  }
  assert.equal(S.caseFold('[a-z0-9_]'), '[a-zA-Z0-9_]', 'letter ranges inside classes are folded');
  // JS reads the same subset (anchors, groups, alternation, folded [xX] classes)
  const re = { test: (p) => bodies.some((b) => new RegExp(b).test(p)) };
  for (const p of ['/h/.nvm/.npmrc', '/h/.nvm/a/b/NPMRC', '/h/.nvm/ID_RSA', '/h/.nvm/id_ed25519', '/h/.nvm/Credentials.TOML.bak', '/h/.nvm/.env.Production', '/h/.nvm/auth.json~',
    '/h/.nvm/x/.git-credentials.swp', '/h/.nvm/pip.ini.old', '/h/.nvm/_netrc', '/h/.nvm/bunfig.toml.orig']) assert.ok(re.test(p), p);
  for (const n of NEAR_MISS) assert.ok(!re.test(`/h/.nvm/${n}`), n);
  assert.ok(!re.test('/h/.nvmx/.npmrc') && !re.test('/other/.npmrc'));
});

test('R3 gitSafe: http.followRedirects=false; positional network URLs pass the same host check (unsafeAllowLocalUrls for tests only)', (t) => {
  const repo = repoWithCommit(t);
  assert.ok(G.GIT_SAFE_FLAGS.includes('http.followRedirects=false'));
  for (const [args, bad] of [[['ls-remote', 'https://127.0.0.1/x'], true], [['fetch', 'git@10.0.0.1:a/b'], true], [['clone', 'file:///tmp/x', 'y'], true],
    [['pull', 'https://metadata.google.internal/x'], true], [['push', 'ssh://git@localhost./a', 'main'], true], [['remote', 'add', 'o', 'https://192.168.1.2/x'], true],
    [['ls-remote', 'https://169.254.169.254/latest'], true], [['fetch', 'http://example.com/x.git'], true], [['ls-remote', '--', 'https://10.1.1.1/x'], true]]) {
    assert.throws(() => G.gitSafeOpts(repo, args, { timeout: 5000 }), /git URL not allowed/, args.join(' '));
  }
  assert.doesNotThrow(() => G.checkNetworkArgs(['ls-remote', 'https://github.com/example/repo.git', 'HEAD']));
  assert.doesNotThrow(() => G.checkNetworkArgs(['show', 'HEAD:a.txt']));
  assert.doesNotThrow(() => G.checkNetworkArgs(['ls-remote', 'https://127.0.0.1/x'], { unsafeAllowLocalUrls: true }));
});

test('R3 publicHost: localdomain, internal, home.arpa, local, localhost names and metadata hosts are refused', () => {
  for (const h of ['localhost.localdomain', 'x.localdomain', 'metadata.google.internal', 'svc.internal', 'router.home.arpa', 'printer.local', 'a.localhost', 'LOCALHOST.', 'Foo.Internal.',
    'localhost..', 'a..b.com', 'ip6-localhost', '127.0.0.1.nip.io', 'x.10.0.0.1.sslip.io']) {
    assert.equal(G.publicHost(h), false, h);
  }
  for (const h of ['github.com', 'internal.example.com', 'local.example.org', 'arpa.example.net', 'cafe.babe', '1password.com', 'v1.2.example.com']) assert.equal(G.publicHost(h), true, h);
});

test('R3 sandboxProfile: a long toolchain path still yields a parseable profile; over-long paths are refused clearly', { skip: SKIP }, async (t) => {
  const w = world(t);
  const deep = path.join(w.fh, 'work', 'wt', 'x'.repeat(120), 'y'.repeat(120), 'toolchain'); fs.mkdirSync(deep, { recursive: true });
  const prof = profileOf(w, 'none', { readAllow: [deep] });
  assert.equal((await S.runSandboxed(['/usr/bin/true'], { cwd: w.work, profile: prof })).code, 0);
  assert.throws(() => S.sbplString('z'.repeat(1001)), /longer than 1000/);
});

test('R3 addendum gitSafe: positional args of network commands are remote names, refspecs or checked https/ssh URLs; scp-like forms are refused', (t) => {
  const bad = [['fetch', '127.0.0.1:path'], ['fetch', 'localhost:path'], ['ls-remote', '[::1]:path'], ['clone', 'git@127.0.0.1:o/r', 'dst'], ['pull', 'host:path'],
    ['push', 'git@github.com:o/r.git', 'main'], ['fetch', 'https://127.0.0.1/x'], ['fetch', 'http://example.com/x'], ['fetch', 'file:///tmp/x'], ['fetch', '/tmp/repo'],
    ['fetch', './repo'], ['fetch', 'origin', 'x:y'], ['fetch', 'origin', 'main:main'], ['clone', '/tmp/src', 'dst'], ['fetch', '--upload-pack=x:y', 'origin'], ['fetch', 'origin', 'a b']];
  const R = { remotes: new Set(['origin']) };
  for (const args of bad) {
    assert.throws(() => G.checkNetworkArgs(args, R), (e) => /^git (URL|option) not allowed: argument \d+$/.test(e.message) && !e.message.includes(args.at(-1)), args.join(' '));
  }
  const good = [['fetch', 'origin'], ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'], ['push', 'origin', 'HEAD:refs/heads/x'], ['push', 'origin', 'refs/heads/a:refs/heads/b'],
    ['fetch', 'origin', 'refs/heads/main'], ['fetch', 'origin', 'feature/x'], ['fetch', '--prune', 'origin'], ['ls-remote', 'https://github.com/o/r.git'],
    ['ls-remote', 'ssh://git@github.com/o/r.git', 'HEAD'], ['clone', 'https://github.com/o/r.git', 'dst'], // an absolute destination is refused since round 4
    ['push', 'origin', ':refs/heads/old'], ['remote', 'add', 'up', 'https://gitlab.com/a/b.git'], ['fetch', 'origin', 'v1.2.3']];
  for (const args of good) assert.doesNotThrow(() => G.checkNetworkArgs(args, R), args.join(' '));
  const repo = repoWithCommit(t);
  assert.throws(() => G.gitSafe(repo, 'fetch', '127.0.0.1:path'), /^Error: git URL not allowed: argument 1$/);
});

// ---- fix round 4: nested .git, worktree preflight, configured remotes, option allowlist, key material ------------------------------
test('R4 sandbox: no .git file or directory can be created or written at ANY depth of the worktree (the run temp may hold repos)', { skip: SKIP }, async (t) => {
  const w = world(t);
  fs.mkdirSync(path.join(w.work, 'vendor', 'pre'), { recursive: true }); fs.writeFileSync(path.join(w.work, 'vendor', 'pre', 'x'), 'x');
  const r = await sb(w, `const W=A[0];const sh=(c)=>{try{cp.execFileSync('/bin/sh',['-c',c],{cwd:W,stdio:'ignore'});return 'OK'}catch{return 'FAIL'}};
    out({ nestedDir: t(()=>fs.mkdirSync(path.join(W,'vendor/lib/.git'),{recursive:true})), nestedCfg: sh('mkdir -p vendor/lib && echo "[filter \\"x\\"]" > vendor/lib/.git'),
      upper: t(()=>fs.mkdirSync(path.join(W,'vendor/.GIT'))), gitfile: t(()=>fs.writeFileSync(path.join(W,'vendor/pre/.git'),'gitdir: /tmp/x')),
      mv: t(()=>fs.renameSync(path.join(W,'vendor/pre/x'),path.join(W,'vendor/pre/.git'))), mvDir: sh('mkdir -p d/repo && mv d/repo d/.git'),
      symlink: t(()=>fs.symlinkSync('/tmp',path.join(W,'vendor/.git'))), hardlink: t(()=>fs.linkSync(path.join(W,'vendor/pre/x'),path.join(W,'a/.git'.replace('a/','vendor/')))),
      gitInit: sh('git init -q sub'), gitInitTmp: sh('cd "$TMPDIR" && git init -q tmprepo && git -C tmprepo -c user.name=a -c user.email=a@b commit -q --allow-empty -m x'),
      gitignore: t(()=>fs.writeFileSync(path.join(W,'.gitignore'),'x')), github: t(()=>{fs.mkdirSync(path.join(W,'.github/workflows'),{recursive:true});fs.writeFileSync(path.join(W,'.github/workflows/ci.yml'),'x')}),
      attrs: t(()=>fs.writeFileSync(path.join(W,'vendor/.gitattributes'),'x')), dotgitSuffix: t(()=>fs.mkdirSync(path.join(W,'foo.git'))), blame: t(()=>fs.writeFileSync(path.join(W,'.git-blame-ignore-revs'),'x')) })`,
  { args: [w.work] });
  assert.deepEqual(r, { nestedDir: 'EPERM', nestedCfg: 'FAIL', upper: 'EPERM', gitfile: 'EPERM', mv: 'EPERM', mvDir: 'FAIL', symlink: 'EPERM', hardlink: 'EPERM', gitInit: 'FAIL',
    gitInitTmp: 'OK', gitignore: 'OK', github: 'OK', attrs: 'OK', dotgitSuffix: 'OK', blame: 'OK' });
  assert.equal(fs.existsSync(path.join(w.work, 'vendor', 'lib', '.git')), false);
});

function nestedRepo(t) {
  const repo = repoWithCommit(t); const marker = path.join(repo, '..', `${path.basename(repo)}-CLEAN-RAN`); gone(t, marker);
  const sub = path.join(repo, 'vendor', 'lib'); fs.mkdirSync(sub, { recursive: true });
  git(sub, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(sub, '.gitattributes'), '* filter=x\n'); fs.writeFileSync(path.join(sub, 'f'), '1');
  git(sub, 'add', '.'); git(sub, '-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-qm', 's');
  git(sub, 'config', 'filter.x.clean', `sh -c 'touch "${marker}"; cat'`); fs.writeFileSync(path.join(sub, 'f'), '2');
  return { repo, marker, sub };
}

test('R4 gitSafe: an embedded repo (nested .git with a filter) makes worktree commands THROW before git runs; SAFE commands still work', (t) => {
  const { repo, marker } = nestedRepo(t);
  for (const cmd of [['add', '-A'], ['status', '--porcelain'], ['commit', '-qm', 'x'], ['diff'], ['diff', 'HEAD~0'], ['diff', 'HEAD~1', 'HEAD'], ['log', 'HEAD'], ['show', 'main'], ['checkout', 'other'], ['stash'], ['log', '-p']]) {
    assert.throws(() => G.gitSafe(repo, ...cmd), /^Error: git worktree not safe: nested \.git at entry \d+$/, cmd.join(' '));
  }
  assert.equal(fs.existsSync(marker), false, 'the nested repo\'s clean filter ran');
  const head = git(repo, 'rev-parse', 'HEAD').stdout.trim(), other = git(repo, 'rev-parse', 'other').stdout.trim();
  for (const cmd of [['rev-parse', 'HEAD'], ['ls-tree', '-r', head], ['diff', head, other], ['log', '--format=%H', head], ['show', `${head}`], ['cat-file', '-t', head],
    ['for-each-ref'], ['show-ref'], ['rev-list', head], ['merge-base', head, other], ['diff', 'refs/heads/main', 'refs/heads/other'], ['config', '--get', 'core.bare']]) {
    assert.equal(G.gitSafe(repo, ...cmd).code, 0, cmd.join(' '));
  }
  assert.throws(() => G.gitSafe(repo, 'diff', '--submodule=diff', head, other), /worktree not safe/);
  assert.throws(() => G.gitSafe(repo, 'diff', head, other, '--', 'a.txt'), /worktree not safe/);
  assert.throws(() => G.gitSafe(repo, 'diff', '--ext-diff', head, other), /option not allowed/);
  assert.equal(fs.existsSync(marker), false);
  git(repo, 'add', '-A'); git(repo, 'diff'); // control: once staged as a gitlink, plain `git diff` runs the embedded repo's filter
  assert.equal(fs.existsSync(marker), true, 'control: plain git add -A + diff runs the embedded repo\'s clean filter');
});

test('R4 gitSafe: gitlinks in the index, .gitmodules, nested .git FILES and symlinks named .git all throw; a clean tree passes', (t) => {
  const a = repoWithCommit(t); git(a, 'update-index', '--add', '--cacheinfo', `160000,${git(a, 'rev-parse', 'HEAD').stdout.trim()},sub`);
  assert.throws(() => G.gitSafe(a, 'status'), /^Error: git worktree not safe: gitlink in the index$/);
  const b = repoWithCommit(t); fs.writeFileSync(path.join(b, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = https://github.com/o/r\n');
  assert.throws(() => G.gitSafe(b, 'status'), /^Error: git worktree not safe: \.gitmodules present$/);
  const c = repoWithCommit(t); fs.mkdirSync(path.join(c, 'd')); fs.writeFileSync(path.join(c, 'd', '.git'), 'gitdir: /tmp/elsewhere\n');
  assert.throws(() => G.gitSafe(c, 'status'), /nested \.git/);
  const d = repoWithCommit(t); fs.mkdirSync(path.join(d, 'e')); fs.symlinkSync('/tmp', path.join(d, 'e', '.GIT'));
  assert.throws(() => G.gitSafe(d, 'status'), /nested \.git/);
  const e = repoWithCommit(t); fs.mkdirSync(path.join(e, 'deep', 'er'), { recursive: true }); fs.symlinkSync(os.tmpdir(), path.join(e, 'deep', 'link')); // symlinks are not followed
  assert.equal(G.gitSafe(e, 'status', '--porcelain').code, 0);
  assert.equal(G.gitSafeOpts(a, ['status'], { unsafeSkipWorktreeCheck: true }).code, 0, 'test-only opt-out');
});

test('R4 gitSafe: the worktree walk is capped (over the cap THROWS); the cap can only be lowered', (t) => {
  const repo = repoWithCommit(t); fs.mkdirSync(path.join(repo, 'many'));
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(repo, 'many', `f${i}`), '');
  assert.throws(() => G.gitSafeOpts(repo, ['status'], { worktreeWalkCap: 50 }), /^Error: git worktree not safe: more than 50 entries$/);
  assert.equal(G.gitSafeOpts(repo, ['status'], { worktreeWalkCap: 500 }).code, 0);
  assert.equal(G.WORKTREE_WALK_CAP, 100000);
  assert.throws(() => G.gitSafeOpts(repo, ['status'], { worktreeWalkCap: 10 ** 9 }), /worktreeWalkCap/);
});

test('R4 gitSafe: an unconfigured remote NAME is refused (no fall-through to a builder-planted local repo); file transport is off', (t) => {
  const repo = repoWithCommit(t); const marker = path.join(repo, '..', `${path.basename(repo)}-HOOK`); gone(t, marker);
  const ev = path.join(repo, 'origin'); git(repo, 'init', '-q', '--bare', ev);
  for (const h of ['pre-receive', 'post-receive', 'update', 'reference-transaction']) fs.writeFileSync(path.join(ev, 'hooks', h), `#!/bin/sh\ntouch "${marker}"\ncat >/dev/null\n`, { mode: 0o755 });
  const opts = { unsafeSkipWorktreeCheck: true };
  for (const args of [['push', 'origin', 'HEAD:refs/heads/x'], ['fetch', 'origin'], ['ls-remote', 'origin'], ['pull', '--ff-only', 'origin', 'main']]) {
    assert.throws(() => G.gitSafeOpts(repo, args, opts), /^Error: git remote not configured: argument \d+$/, args.join(' '));
  }
  assert.ok(G.GIT_SAFE_FLAGS.includes('protocol.file.allow=never'));
  const r = G.gitSafeOpts(repo, ['push', './origin', 'HEAD:refs/heads/x'], { ...opts, unsafeAllowLocalUrls: true });
  assert.notEqual(r.code, 0); assert.match(r.err, /transport 'file' not allowed/);
  assert.equal(fs.existsSync(marker), false, 'a receive hook in the planted repo ran');
  spawnSync('git', ['push', './origin', 'HEAD:refs/heads/x'], { cwd: repo, env: G.gitEnv(), stdio: 'ignore' });
  assert.equal(fs.existsSync(marker), true, 'control: plain git push to the local path runs its receive hooks');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
  assert.doesNotThrow(() => G.checkNetworkArgs(['push', 'origin', 'HEAD:refs/heads/x'], { remotes: new Set(['origin']) }));
});

test('R4 gitSafe: network-command options are allowlisted per command; clone needs an https/ssh URL and a relative destination; submodule is refused', (t) => {
  const R = { remotes: new Set(['origin']) };
  const bad = [['fetch', '--upload-pack=x', 'origin'], ['fetch', '--upload-pack', 'x', 'origin'], ['push', '--receive-pack=x', 'origin'], ['push', '--exec=x', 'origin'],
    ['clone', '--template=/x', 'https://github.com/o/r.git', 'd'], ['clone', '--config=filter.x.smudge=touch PWN', 'https://github.com/o/r.git', 'd'], ['clone', '-c', 'a=b', 'https://github.com/o/r.git', 'd'],
    ['fetch', '--recurse-submodules', 'origin'], ['fetch', '--recurse-submodules=yes', 'origin'], ['push', '--server-option=x', 'origin'], ['push', '-o', 'x', 'origin'],
    ['clone', '--separate-git-dir=/x', 'https://github.com/o/r.git', 'd'], ['clone', '--reference=/x', 'https://github.com/o/r.git', 'd'], ['clone', '--shared', 'https://github.com/o/r.git', 'd'],
    ['clone', '--mirror', 'https://github.com/o/r.git', 'd'], ['clone', '--bare', 'https://github.com/o/r.git', 'd'], ['push', '--force-with-lease', 'origin'], ['fetch', '--depth=x', 'origin'],
    ['fetch', '-j', '4', 'origin']];
  for (const args of bad) assert.throws(() => G.checkNetworkArgs(args, R), (e) => /^git option not allowed: argument \d+$/.test(e.message), args.join(' '));
  for (const args of [['clone', 'https://github.com/o/r.git', '/tmp/abs'], ['clone', 'https://github.com/o/r.git', '../up'], ['clone', 'https://github.com/o/r.git', 'a/../../x'],
    ['clone', 'origin', 'd'], ['clone', 'git@github.com:o/r.git', 'd'], ['clone', 'https://github.com/o/r.git', 'd', 'extra']]) {
    assert.throws(() => G.checkNetworkArgs(args, R), /not allowed: argument \d+|not configured/, args.join(' '));
  }
  const good = [['fetch', '--prune', '--no-tags', '--depth=1', '-q', 'origin'], ['fetch', '--all', '--tags'], ['push', '--force', '--atomic', '-u', '--no-verify', '--porcelain', 'origin', 'HEAD:refs/heads/x'],
    ['pull', '--ff-only', '--no-recurse-submodules', 'origin', 'main'], ['ls-remote', '--tags', 'origin'], ['clone', '-b', 'main', '--single-branch', '--depth=1', '--no-checkout', 'https://github.com/o/r.git', 'dst'],
    ['clone', '--origin', 'up', '-q', 'https://github.com/o/r.git', 'a/b'], ['clone', '-o', 'up', 'https://github.com/o/r.git'], ['fetch', '-v', 'origin', '--', 'main']];
  for (const args of good) assert.doesNotThrow(() => G.checkNetworkArgs(args, R), args.join(' '));
  const repo = repoWithCommit(t); const marker = path.join(repo, 'PWN');
  assert.throws(() => G.gitSafeOpts(repo, ['clone', `--config=filter.x.smudge=touch ${marker}`, 'https://github.com/o/r.git', 'd'], {}), /option not allowed: argument 1/);
  assert.throws(() => G.gitSafe(repo, 'submodule', 'update', '--init'), /^Error: gitSafe: submodule is not supported$/);
  assert.equal(fs.existsSync(marker), false);
});

test('R4 SBPL length is checked on the FINAL escaped regex body: a 790-character dotted path fails with the clear error', (t) => {
  const w = { fh: path.join(tmp(t), 'fh') }; fs.mkdirSync(path.join(w.fh, 'work'), { recursive: true });
  let deep = tmp(t, 'f-'); while (deep.length < 770) deep = path.join(deep, 'a.b.c.d.e.f.g.h.i.j');
  deep = path.join(deep, 'x'.repeat(790 - deep.length - 1)); fs.mkdirSync(deep, { recursive: true });
  assert.equal(deep.length, 790);
  assert.throws(() => S.sandboxProfile({ writable: [], network: 'none', factoryHome: w.fh, readAllow: [deep] }), /SBPL string longer than 1000 characters/);
});

test('R4 sandbox fs: key material in toolchain dirs is denied (dot-anchored .key/.p12/.pfx, private-key-shaped .pem, token(s).json); certificates stay readable', { skip: SKIP }, async (t) => {
  const w = world(t); const H = fakeHome(t);
  const T = path.join(H, '.nvm', 'kx');
  const denied = ['server.key', 'ID.P12', 'x.pfx', 'privkey.pem', 'privkey1.pem', 'private.pem', 'private-tls.pem', 'tls-key.pem', 'my_key.pem', 'token.json', 'tokens.json', 'deep/Server.KEY', 'token.json.bak'];
  const readable = ['cacert.pem', 'certifi/cacert.pem', 'ca-bundle.crt', 'credentials.js', 'lib/credentials.js', 'cert.pem', 'fullchain.pem', 'key.pem.js', 'monkey.keys', 'tokenize.js', 'token.rs', 'token.py'];
  for (const n of [...denied, ...readable]) { const f = path.join(T, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'S'); }
  const r = await sb(w, `out(JSON.parse(A[1]).map(n=>t(()=>fs.readFileSync(path.join(A[0],n),'utf8'))))`, { args: [T, JSON.stringify([...denied, ...readable])], profile: profileOf(w, 'none', { home: H }) });
  assert.deepEqual(Object.fromEntries([...denied, ...readable].map((n, i) => [n, r[i]])), Object.fromEntries([...denied.map((n) => [n, 'EPERM']), ...readable.map((n) => [n, 'S'])]));
});
