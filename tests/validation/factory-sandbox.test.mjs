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
import { spawnSync } from 'node:child_process';
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
  return { root, fh, work, outside, tmpDir };
}
const profileOf = (w, network = 'none', extra = {}) => S.sandboxProfile({ writable: [w.work], tmpDir: w.tmpDir, network, factoryHome: w.fh, ...extra });

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

test('gitSafe: repo-configured fsmonitor, external diff and ext:: transport never run', (t) => {
  const repo = repoWithCommit(t); const mk = (n) => path.join(repo, `${n}-RAN`);
  const script = (n) => { const f = path.join(repo, `${n}.sh`); fs.writeFileSync(f, `#!/bin/sh\ntouch "${mk(n)}"\n`, { mode: 0o755 }); return f; };
  git(repo, 'config', 'core.fsmonitor', script('fsmon'));
  git(repo, 'config', 'diff.external', script('extdiff'));
  git(repo, 'config', 'protocol.ext.allow', 'always');
  git(repo, 'config', 'diff.conv.textconv', script('textconv'));
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt diff=conv\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  assert.equal(G.gitSafe(repo, 'status', '--porcelain').code, 0);
  const d = G.gitSafe(repo, 'diff');
  assert.equal(d.code, 0); assert.match(d.out, /^-one\n\+two\n/m);
  G.gitSafe(repo, 'ls-remote', `ext::${script('ext')}`);
  for (const n of ['fsmon', 'extdiff', 'ext', 'textconv']) assert.equal(fs.existsSync(mk(n)), false, `${n} ran under gitSafe`);
  git(repo, 'diff'); // control: plain git honours the planted diff.external
  assert.equal(fs.existsSync(mk('extdiff')), true, 'control: plain git should run diff.external');
});

test('gitSafe: repo-configured core.sshCommand is replaced by plain ssh', (t) => {
  const repo = repoWithCommit(t); const marker = path.join(repo, 'SSH-RAN');
  const f = path.join(repo, 'ssh.sh'); fs.writeFileSync(f, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
  git(repo, 'config', 'core.sshCommand', f);
  // Port 1 on loopback: ssh fails immediately with connection refused; nothing leaves the machine.
  G.gitSafe(repo, 'ls-remote', 'ssh://git@127.0.0.1:1/x.git');
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
  const e = G.gitEnv({ PATH: '/bin', HOME: '/h', GIT_SSH_COMMAND: 'x', GIT_ASKPASS: 'x', GIT_PAGER: 'x', git_dir: 'x', GIT_CONFIG_PARAMETERS: 'x' });
  assert.deepEqual(e, { PATH: '/bin', HOME: '/h', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
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
  const prof = S.sandboxProfile({ writable: [raw], tmpDir: path.join(fh, 'tmp'), network: 'none', factoryHome: fh, home: '/Users/someone' });
  const realRaw = fs.realpathSync(raw);
  if (realRaw !== raw) assert.ok(!prof.includes(`"${raw}"`), 'non-realpath writable leaked into the profile');
  assert.ok(prof.includes(`(subpath "${realRaw}")`));
  const idx = (s) => { const i = prof.indexOf(s); assert.ok(i >= 0, `missing ${s}\n${prof}`); return i; };
  assert.ok(idx('(allow default)') < idx('(deny file-write*)'));
  assert.ok(idx('(deny file-write*)') < idx('(allow file-read* file-write*'));
  assert.ok(idx('(deny file-read*') < idx('(allow file-read* file-write*'));
  assert.ok(idx('(allow file-read* file-write*') < idx(`(deny file-write* (subpath "${realRaw}/.git")`));
  assert.ok(idx('(deny mach-lookup)') < idx('(allow mach-lookup'));
  const denyRead = prof.split('\n').find((l) => l.startsWith('(deny file-read*'));
  for (const s of ['.ssh', '.aws', '.config/gh', '.netrc', 'Library/Keychains', '.claude', '.claude.json', '.gnupg']) assert.ok(denyRead.includes(`(subpath "/Users/someone/${s}")`), s);
  assert.ok(denyRead.includes(`(subpath "${fh}")`), 'FACTORY_HOME must be read-denied');
  assert.ok(prof.includes(`(literal "${path.dirname(realRaw)}")`), 'ancestors get stat-only access');
  for (const n of ['com.apple.coreservices.launchservicesd', 'com.apple.cfprefsd', 'com.apple.SecurityServer', 'pasteboard']) assert.ok(!prof.includes(n), n);
});

test('sandboxProfile: escaping, control characters, relative/missing/protected paths and bad network specs', (t) => {
  const root = tmp(t);
  const weird = path.join(root, 'we"ird\\dir'); fs.mkdirSync(weird);
  const prof = S.sandboxProfile({ writable: [weird], network: 'none', factoryHome: path.join(root, 'fh') });
  assert.ok(prof.includes(`(subpath "${root}/we\\"ird\\\\dir")`), prof);
  assert.throws(() => S.sandboxProfile({ writable: [path.join(root, 'a\nb')], network: 'none' }), /control character/);
  assert.throws(() => S.sandboxProfile({ writable: [root], readDeny: [`${root}/x\u0000`], network: 'none' }), /control character/);
  assert.throws(() => S.sandboxProfile({ writable: ['rel/dir'], network: 'none' }), /absolute/);
  assert.throws(() => S.sandboxProfile({ writable: [path.join(root, 'missing')], network: 'none' }), /does not exist/);
  assert.throws(() => S.sandboxProfile({ writable: [root], network: 'none', factoryHome: path.join(root, 'fh') }), /contains protected path/);
  assert.throws(() => S.sandboxProfile({ writable: [os.homedir()], network: 'none' }), /contains protected path/);
  assert.throws(() => S.sandboxProfile({ writable: ['/'], network: 'none' }), /must not be \/|protected/);
  for (const bad of [undefined, 'all', { localhostPort: 0 }, { localhostPort: 70000 }, { localhostPort: '80' }, { localhostPort: 80, extra: 1 }]) {
    assert.throws(() => S.sandboxProfile({ writable: [weird], network: bad, factoryHome: path.join(root, 'fh') }), /network|localhostPort/);
  }
});

test('sandboxProfile: network rules per mode', (t) => {
  const root = tmp(t); const base = { writable: [root], factoryHome: '/nonexistent/fh' };
  const none = S.sandboxProfile({ ...base, network: 'none' });
  assert.match(none, /\(deny network\*\)\n?$/); assert.ok(!/allow network/.test(none));
  const reg = S.sandboxProfile({ ...base, network: 'registries' });
  assert.ok(reg.indexOf('(deny network*)') < reg.indexOf('(allow network-outbound (remote tcp "*:443") (remote tcp "*:80") (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'));
  const lp = S.sandboxProfile({ ...base, network: { localhostPort: 4321 } });
  assert.ok(lp.includes('(allow network-outbound (remote ip "localhost:4321"))') && lp.includes('(allow network-bind network-inbound (local ip "localhost:4321"))'));
  assert.ok(!lp.includes('mDNSResponder') && !lp.includes('*:443'));
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

test('sandbox fs: FACTORY_HOME and credential dirs are unreadable; normal files, modules and npm still work', { skip: SKIP }, async (t) => {
  const w = world(t);
  const r = await sb(w, `out({
    secret: t(()=>fs.readFileSync(path.join(A[1],'scenarios','secret.txt'),'utf8')), list: t(()=>fs.readdirSync(A[1]).join()),
    listScen: t(()=>fs.readdirSync(path.join(A[1],'scenarios')).join()), ssh: t(()=>fs.readdirSync(path.join(os.homedir(),'.ssh')).length>=0),
    normal: t(()=>fs.readFileSync(path.join(A[2],'normal.txt'),'utf8')), mod: t(()=>require(path.join(A[0],'mod.js'))),
    npm: t(()=>cp.execFileSync('npm',['--version'],{encoding:'utf8'}).trim().length>0),
    cat: t(()=>cp.execFileSync('/bin/cat',[path.join(A[1],'scenarios','secret.txt')],{encoding:'utf8',stdio:['ignore','pipe','pipe']})),
  })`, { args: [w.work, w.fh, w.outside] });
  assert.equal(r.secret, 'EPERM'); assert.equal(r.list, 'EPERM'); assert.equal(r.listScen, 'EPERM');
  if (fs.existsSync(path.join(os.homedir(), '.ssh'))) assert.equal(r.ssh, 'EPERM');
  assert.notEqual(r.cat, 'SENTINEL-SECRET\n'); assert.match(String(r.cat), /Command failed/);
  assert.equal(r.normal, 'NORMAL\n'); assert.equal(r.mod, 42); assert.equal(r.npm, true);
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

test('sandbox net: registries allows only tcp 80/443 (an ephemeral localhost port is denied); none denies everything', { skip: SKIP }, async (t) => {
  const w = world(t);
  const eph = await serve(t, 0);
  let p443 = null; try { p443 = await serve(t, 443); } catch { t.diagnostic('could not listen on 127.0.0.1:443; positive 443 check skipped'); }
  const code = `(async()=>out({ eph: await conn('127.0.0.1',+A[0]), p443: A[1]?await conn('127.0.0.1',443):'skip', listen: await listen('127.0.0.1',0),
    ssh: await conn('127.0.0.1',22), unix: await new Promise(r=>{const s=net.connect('/private/var/run/mDNSResponder');s.on('connect',()=>{s.destroy();r('OK')});s.on('error',e=>r(e.code))}),
    agent: await new Promise(r=>{if(!process.env.SSH_AUTH_SOCK)return r('none');const s=net.connect(process.env.SSH_AUTH_SOCK);s.on('connect',()=>{s.destroy();r('OK')});s.on('error',e=>r(e.code))}) }))()`;
  const reg = await sb(w, code, { network: 'registries', args: [String(eph), p443 ? '1' : ''] });
  assert.equal(reg.eph, 'EPERM'); assert.equal(reg.listen, 'EPERM'); assert.equal(reg.ssh, 'EPERM'); assert.equal(reg.unix, 'OK');
  if (p443) assert.equal(reg.p443, 'OK');
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
