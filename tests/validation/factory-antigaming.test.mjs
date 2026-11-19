// factory verification gate (Phase 1a, P1.3): anti-gaming diff checks G1-G5 against a real git repo with a bare origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const LIB = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib');
const ag = await import(path.join(LIB, 'antigaming.mjs'));
const crit = await import(path.join(LIB, 'criteria.mjs'));
const BASE = 'refs/remotes/origin/main';

// Base commit pushed to a bare origin; the feature branch commits on top. Returns helpers bound to the work tree.
function fixture(files) {
  const root = tmpDir('antigaming-');
  const origin = path.join(root, 'origin.git'); const work = path.join(root, 'work');
  const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'init', '-q', '-b', 'main', work);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 't'], ['commit.gpgsign', 'false']]) sh(work, 'config', k, v);
  sh(work, 'remote', 'add', 'origin', origin);
  const write = (fs_) => {
    for (const [p, c] of Object.entries(fs_)) {
      const abs = path.join(work, p);
      if (c === null) fs.rmSync(abs);
      else if (typeof c === 'object' && c.link) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.rmSync(abs, { force: true }); fs.symlinkSync(c.link, abs); }
      else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, c); }
    }
  };
  write({ 'README.md': 'hello\n', ...files });
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'base');
  sh(work, 'push', '-q', 'origin', 'main'); sh(work, 'fetch', '-q', 'origin');
  sh(work, 'checkout', '-q', '-b', 'feat');
  const git = (...a) => { const r = spawnSync('git', a, { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const change = (fs_, { mv, fresh } = {}) => {
    if (fresh) sh(work, 'checkout', '-q', '-B', 'feat', BASE);
    if (mv) sh(work, 'mv', '--', mv[0], mv[1]);
    write(fs_);
    sh(work, 'add', '-A'); sh(work, 'commit', '-q', '--allow-empty', '-m', 'change');
    return sh(work, 'rev-parse', 'HEAD');
  };
  return { root, work, git, change, sh };
}

const run = (fx, headSha, config = {}, specPaths = [], extra = {}) => ag.checkDiff({ git: fx.git, baseRef: BASE, headSha, config, specPaths, ...extra });
const ids = (hits) => hits.map((h) => h.id).sort();
const hit = (hits, id) => hits.find((h) => h.id === id);

// ---- G1 -----------------------------------------------------------------------------------------------------------------
test('G1: modifying or deleting a test file present on base fires; adding a new test file does not', () => {
  const fx = fixture({ 'src/a.test.js': 'test("a", () => {});\n', 'tests/test_b.py': 'def test_b(): pass\n', 'pkg/x_test.go': 'package x\n' });
  const h1 = run(fx, fx.change({ 'src/a.test.js': 'test("a", () => { /* weaker */ });\n', 'tests/test_b.py': null }));
  assert.deepEqual(hit(h1, 'G1').files.sort(), ['src/a.test.js', 'tests/test_b.py']);
  const h2 = run(fx, fx.change({ 'src/new.test.js': 'test("n", () => {});\n', 'pkg/y_test.go': 'package x\n' }));
  assert.equal(hit(h2, 'G1').files.includes('src/new.test.js'), false);
});
test('G1: a renamed test file counts as modified (no rename detection)', () => {
  const fx = fixture({ 'src/a.spec.ts': 'it("a", () => {});\n' });
  const h = run(fx, fx.change({}, { mv: ['src/a.spec.ts', 'src/b.spec.ts'] }));
  assert.deepEqual(hit(h, 'G1').files, ['src/a.spec.ts']);
});
test('G1: __tests__/ and verification.test_globs mark test files; absolute and .. globs are ignored', () => {
  const fx = fixture({ '__tests__/u.js': 'x\n', 'checks/c.js': 'x\n', 'src/plain.js': 'x\n' });
  const head = fx.change({ '__tests__/u.js': 'y\n', 'checks/c.js': 'y\n', 'src/plain.js': 'y\n' });
  assert.deepEqual(hit(run(fx, head, { verification: { test_globs: ['checks/**'] } }), 'G1').files.sort(), ['__tests__/u.js', 'checks/c.js']);
  assert.deepEqual(hit(run(fx, head, { verification: { test_globs: ['/**', '../**', '**/../**'] } }), 'G1').files, ['__tests__/u.js']);
});
test('G1 near-miss: a non-test file whose name only contains "test" is not a test file', () => {
  const fx = fixture({ 'src/latest.js': 'x\n', 'src/contest/run.js': 'x\n' });
  assert.deepEqual(run(fx, fx.change({ 'src/latest.js': 'y\n', 'src/contest/run.js': 'y\n' })), []);
});

// ---- G2 -----------------------------------------------------------------------------------------------------------------
test('G2: skip/only markers added in test files fire, in every listed form', () => {
  const cases = ['it.skip("x", f)', 'describe.only("x", f)', 'xit("x", f)', 'xdescribe("x", f)', 'test.skip("x")', '@pytest.mark.skip(reason="x")',
    '@pytest.mark.xfail', '@Disabled', 't.Skip("later")', 'pytest.skip("x")', 'describe["skip"]("x", f)', "it['only']('x', f)", 'fit("x", f)', 'test.skip.each([1])("x")'];
  const fx = fixture({});
  for (const c of cases) {
    const h = run(fx, fx.change({ 'tests/new_case.js': `${c}\n` }, { fresh: true }));
    assert.deepEqual(hit(h, 'G2')?.files, ['tests/new_case.js'], c);
  }
});
test('G2 near-miss: "skip" in a comment of a non-test file is not a hit; a pre-existing .only( is ignored', () => {
  const fx = fixture({ 'src/a.test.js': 'it.only("a", f);\nconst n = 1;\n' });
  const h = run(fx, fx.change({ 'src/util.js': '// we skip nothing here; rows.skip(2) is a stream call\nexport const skip = 1;\n', 'src/a.test.js': 'it.only("a", f);\nconst n = 2;\n' }));
  assert.deepEqual(ids(h), ['G1']); // the edit to a.test.js is G1, but its unchanged .only( line is not G2
  const h2 = run(fx, fx.change({ 'src/b.test.js': 'const skipped = 0; // the .skip call is not used\nit("fits", f);\n' }));
  assert.equal(hit(h2, 'G2'), undefined);
});
test('G2: trivial dodges fire (alias, destructuring, computed access, inline comment, split lines, bare xit)', () => {
  const fx = fixture({});
  for (const c of ['const s = it.skip;\ns("x", f);', 'const { skip } = test;\nskip("x", f);', "it['sk' + 'ip']('x', f);", 'it./**/skip("x", f);',
    'it.\nskip("x", f);', 'const later = xit;\nlater("x", f);']) {
    assert.deepEqual(hit(run(fx, fx.change({ 'tests/n.test.js': `${c}\n` }, { fresh: true })), 'G2')?.files, ['tests/n.test.js'], c);
  }
  // a "/*" inside a string cannot hide a marker by swallowing it into a fake comment
  assert.ok(hit(run(fx, fx.change({ 'tests/n.test.js': 'const a = "/*"; it.only("x", f); const b = "*/";\n' }, { fresh: true })), 'G2'));
});
test('hostile added content (unclosed comments, braces, long lines) is scanned in bounded time', () => {
  const fx = fixture({});
  const evil = `${'/* { skip '.repeat(60000)}\n${'.'.repeat(200000)}\n${'throw '.repeat(50000)}\n`;
  const t0 = Date.now();
  run(fx, fx.change({ 'tests/evil.test.js': evil, 'src/evil.js': evil }, { fresh: true }));
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('G2: framework-qualified skips in a non-test-named file (test code moved out of a test name) also fire', () => {
  const fx = fixture({});
  for (const c of ['describe.skip("x", f)', 'it["only"]("x", f)', 'xit("x", f)', '@pytest.mark.skip']) {
    assert.deepEqual(hit(run(fx, fx.change({ 'src/helpers.js': `${c}\n` }, { fresh: true })), 'G2')?.files, ['src/helpers.js'], c);
  }
});

// ---- G3 -----------------------------------------------------------------------------------------------------------------
test('G3: stub markers added in non-test code fire, in every listed form', () => {
  const cases = ['raise NotImplementedError', 'unimplemented!()', 'todo!()', 'throw new Error("not implemented")', "throw new Error('Not Implemented')",
    'throw new Error(`not implemented: ${x}`)', 'throw Error("NOT IMPLEMENTED")'];
  const fx = fixture({});
  for (const c of cases) {
    const h = run(fx, fx.change({ 'src/impl.js': `${c}\n` }, { fresh: true }));
    assert.deepEqual(hit(h, 'G3')?.files, ['src/impl.js'], c);
  }
});
test('G3 near-miss: markers in test files, pre-existing markers and markers in docs do not fire', () => {
  const fx = fixture({ 'src/impl.py': 'def f():\n    raise NotImplementedError\nx = 1\n' });
  const h = run(fx, fx.change({ 'src/impl.py': 'def f():\n    raise NotImplementedError\nx = 2\n', 'tests/test_x.py': 'with raises(NotImplementedError): pass\n', 'docs/notes.md': 'todo!() and NotImplementedError\n' }));
  assert.deepEqual(h, []);
});

// ---- G4 -----------------------------------------------------------------------------------------------------------------
test('G4: protected paths fire (config, agent files, CI, test configs, hooks)', () => {
  const paths = ['.product/delivery.json', '.claude/settings.json', '.mcp.json', 'CLAUDE.md', 'docs/AGENTS.md', '.gitattributes', '.gitmodules',
    '.github/workflows/ci.yml', 'jest.config.js', 'web/vitest.config.ts', 'pytest.ini', 'tests/conftest.py', '.mocharc.yml', 'tox.ini',
    'karma.conf.js', 'playwright.config.ts', '.husky/pre-commit', '.githooks/pre-push', 'claude.md',
    'vite.config.ts', '.pytest.ini', 'pytest.toml', '.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', 'jest.setup.js', 'vitest.setup.ts',
    'src/setupTests.ts', 'babel.config.js', '.babelrc', '.babelrc.json', '__mocks__/axios.js', 'src/a/__mocks__/fs.js', '.travis.yml',
    'bitbucket-pipelines.yml', '.drone.yml', '.gitea/workflows/ci.yml', '.forgejo/workflows/ci.yml'];
  const fx = fixture({});
  for (const p of paths) {
    assert.deepEqual(hit(run(fx, fx.change({ [p]: 'x\n' }, { fresh: true })), 'G4')?.files, [p], p);
  }
});
test('G4: any change to Python test configuration files fires (no TOML/INI parsing)', () => {
  const fx = fixture({ 'pyproject.toml': '[project]\nversion = "1"\n', 'setup.cfg': '[metadata]\nname = x\n' });
  assert.deepEqual(hit(run(fx, fx.change({ 'pyproject.toml': '[project]\nversion = "2"\n' }, { fresh: true })), 'G4')?.files, ['pyproject.toml']);
  assert.deepEqual(hit(run(fx, fx.change({ 'setup.cfg': '[metadata]\nname = y\n' }, { fresh: true })), 'G4')?.files, ['setup.cfg']);
});
test('G4: package.json scripts named by tests.all / local_checks (and what they call) fire; other keys do not', () => {
  const pkg = (scripts, extra = {}) => `${JSON.stringify({ name: 'x', version: '1.0.0', scripts, ...extra }, null, 2)}\n`;
  const s0 = { test: 'npm run unit', unit: 'node --test', lint: 'eslint .', build: 'tsc' };
  const fx = fixture({ 'package.json': pkg(s0) });
  const config = { tests: { all: ['npm', 'test'] }, local_checks: [{ name: 'lint', command: ['npm', 'run', 'lint'], timeout_s: 60 }] };
  assert.deepEqual(run(fx, fx.change({ 'package.json': pkg({ ...s0, build: 'tsc -b' }, { version: '1.0.1' }) }), config), [], 'unrelated keys');
  for (const s of [{ ...s0, test: 'true' }, { ...s0, unit: 'true' }, { ...s0, lint: 'true' }, { ...s0, pretest: 'exit 0' }, (({ lint, ...r }) => r)(s0)]) {
    assert.deepEqual(hit(run(fx, fx.change({ 'package.json': pkg(s) }), config), 'G4')?.files, ['package.json'], JSON.stringify(s));
  }
  assert.deepEqual(hit(run(fx, fx.change({ 'package.json': '{ not json' }), config), 'G4')?.files, ['package.json'], 'parse failure');
  assert.deepEqual(run(fx, fx.change({ 'package.json': pkg({ ...s0, test: 'true' }) }), {}), [], 'no npm commands configured');
});

// ---- G5 -----------------------------------------------------------------------------------------------------------------
const SPEC = 'docs/specs/f1.md';
const spec = ({ status = 'ready', ac = 'Users can log in', log = '' } = {}) =>
  `---\nid: FEATURE-1\nstatus: ${status}\n---\n\n# F1\n\n## Acceptance criteria\n\n| ID | Criterion |\n|---|---|\n| AC-1 | ${ac} |\n${log}`;
test('G5: criteria edits fire; status / delivery / Delivery-log edits do not; other specs are ignored', () => {
  const fx = fixture({ [SPEC]: spec(), 'docs/specs/other.md': spec() });
  const ok = run(fx, fx.change({ [SPEC]: spec({ status: 'implemented', log: '\n## Delivery log\n\n| Date | Note |\n|---|---|\n| 2026-11-19 | shipped |\n' }) }), {}, [SPEC]);
  assert.deepEqual(ok, []);
  assert.deepEqual(run(fx, fx.change({ 'docs/specs/other.md': spec({ ac: 'anything' }) }), {}, [SPEC]), []);
  assert.deepEqual(hit(run(fx, fx.change({ [SPEC]: spec({ ac: 'Users can log in, eventually' }) }), {}, [SPEC]), 'G5')?.files, [SPEC]);
  assert.deepEqual(hit(run(fx, fx.change({ [SPEC]: null }), {}, [SPEC]), 'G5')?.files, [SPEC], 'deleted');
});
test('G5: oversize spec or an over-long line is a hit without parsing the head', () => {
  let calls = 0;
  const parser = { canonicalSpec: (t) => { calls++; return crit.canonicalSpec(t); }, specRegions: (t) => { calls++; return crit.specRegions(t); } };
  const fx = fixture({ [SPEC]: spec() });
  const big = run(fx, fx.change({ [SPEC]: spec() + 'x'.repeat(80) + '\n'.repeat(1) + 'y\n'.repeat(130 * 1024) }), {}, [SPEC], { parser });
  assert.deepEqual(hit(big, 'G5')?.files, [SPEC]);
  assert.equal(calls, 0, 'parser not invoked for an oversize spec');
  const long = run(fx, fx.change({ [SPEC]: spec({ ac: 'z'.repeat(crit.MAX_LINE + 1) }) }), {}, [SPEC], { parser });
  assert.deepEqual(hit(long, 'G5')?.files, [SPEC]);
  assert.equal(calls, 0, 'parser not invoked for an over-long line');
});
test('G5: new region problems on the head fire even when the canonical text matches', () => {
  const fx = fixture({ [SPEC]: spec() });
  const head = fx.change({ [SPEC]: spec({ status: 'implemented' }) });
  const parser = { canonicalSpec: () => 'same', specRegions: (t) => ({ ...crit.specRegions(t), problems: t.includes('implemented') ? ['injected'] : [] }) };
  assert.deepEqual(hit(run(fx, head, {}, [SPEC], { parser }), 'G5')?.files, [SPEC]);
});

// ---- hostile names, input validation ------------------------------------------------------------------------------------
test('file names with spaces, newline, unicode, leading dash and shell syntax are handled as data', () => {
  const fx = fixture({});
  const names = ['src/a b.js', 'src/new\nline.js', 'src/ünï.js', 'src/-dash.js', 'src/;$(touch pwned).js', 'src/"q\\uote.js'];
  const files = Object.fromEntries(names.map((n) => [n, 'throw new Error("not implemented")\n']));
  files['tests/-x;$(touch pwned).test.js'] = 'it.only("x", f)\n';
  const h = run(fx, fx.change(files));
  assert.deepEqual(hit(h, 'G3').files.sort(), [...names].sort());
  assert.deepEqual(hit(h, 'G2').files, ['tests/-x;$(touch pwned).test.js']);
  assert.equal(fs.existsSync(path.join(fx.work, 'pwned')), false);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'pwned')), false);
});
test('checkDiff refuses a non-sha head, an unqualified base and a git failure (fail closed)', () => {
  const fx = fixture({});
  const head = fx.change({ 'x.js': '1\n' });
  assert.throws(() => run(fx, 'HEAD'), /head/);
  assert.throws(() => run(fx, head.slice(0, 39)), /head/);
  assert.throws(() => ag.checkDiff({ git: fx.git, baseRef: 'main', headSha: head, config: {}, specPaths: [] }), /base/);
  assert.throws(() => ag.checkDiff({ git: fx.git, baseRef: 'refs/remotes/origin/../x', headSha: head, config: {}, specPaths: [] }), /base/);
  assert.throws(() => run(fx, 'f'.repeat(40)), /git/);
});

// ---- classify / holdReason ----------------------------------------------------------------------------------------------
test('classify follows the P1.3 table', () => {
  const h = (...xs) => xs.map((id) => ({ id, files: ['f'] }));
  assert.equal(ag.classify([], 'built'), 'clean');
  assert.equal(ag.classify([], 'merge'), 'clean');
  for (const id of ['G2', 'G3']) { assert.equal(ag.classify(h(id), 'built'), 'fix'); assert.equal(ag.classify(h(id), 'merge'), 'hold'); }
  for (const id of ['G1', 'G4', 'G5']) { assert.equal(ag.classify(h(id), 'built'), 'hold'); assert.equal(ag.classify(h(id), 'merge'), 'hold'); }
  assert.equal(ag.classify(h('G2', 'G1'), 'built'), 'hold', 'the stricter outcome wins');
  assert.throws(() => ag.classify([], 'pr_open'), /stage/);
});
test('holdReason records the antigaming hold kind and the sorted unique G ids', () => {
  assert.deepEqual(ag.holdReason([{ id: 'G5', files: ['s.md'] }, { id: 'G1', files: ['a.test.js'] }, { id: 'G1', files: ['b.test.js'] }]), { kind: 'antigaming', ids: ['G1', 'G5'] });
  assert.equal(ag.holdReason([]), null);
});

// ---- fix round 1 regressions (reviewer attacks) -------------------------------------------------------------------------
test('type change (file <-> symlink) does not throw: test file -> G1, protected path -> G4, spec -> G5, other file clean', () => {
  const fx = fixture({ 'tests/a.test.js': 'it("a", f)\n', '.mcp.json': '{}\n', 'docs/s.md': '# s\n', 'src/a.js': 'x\n' });
  assert.deepEqual(hit(run(fx, fx.change({ 'tests/a.test.js': { link: '../README.md' } }, { fresh: true })), 'G1')?.files, ['tests/a.test.js']);
  assert.deepEqual(hit(run(fx, fx.change({ '.mcp.json': { link: 'README.md' } }, { fresh: true })), 'G4')?.files, ['.mcp.json']);
  assert.deepEqual(hit(run(fx, fx.change({ 'docs/s.md': { link: '../README.md' } }, { fresh: true }), {}, ['docs/s.md']), 'G5')?.files, ['docs/s.md']);
  assert.deepEqual(run(fx, fx.change({ 'src/a.js': { link: '../README.md' } }, { fresh: true })), []);
});
test('G1: a .test / .spec suffix without an extension is a test file', () => {
  const fx = fixture({ 'src/d.test': 'x\n', 'src/e.spec': 'x\n' });
  assert.deepEqual(hit(run(fx, fx.change({ 'src/d.test': 'y\n', 'src/e.spec': 'y\n' })), 'G1')?.files, ['src/d.test', 'src/e.spec']);
});
test('G4: wildcard / runner script calls protect every script; lifecycle scripts and node --run are protected', () => {
  const pkg = (scripts) => `${JSON.stringify({ name: 'x', scripts }, null, 2)}\n`;
  const npmTest = { tests: { all: ['npm', 'test'] } };
  for (const t of ['run-s "test:*"', 'npm-run-all test:*', 'run-p test:unit', 'concurrently "npm:test:*"', 'pnpm -r --filter ./pkgs/* test:unit']) {
    const s0 = { test: t, 'test:unit': 'node --test', build: 'tsc' };
    const fx = fixture({ 'package.json': pkg(s0) });
    assert.deepEqual(hit(run(fx, fx.change({ 'package.json': pkg({ ...s0, 'test:unit': 'true' }) }), npmTest), 'G4')?.files, ['package.json'], t);
  }
  const s1 = { test: 'jest', unit: 'jest --ci', postinstall: 'echo', prepare: 'husky' };
  const fx = fixture({ 'package.json': pkg(s1) });
  for (const k of ['postinstall', 'prepare', 'preinstall', 'prepack']) {
    assert.deepEqual(hit(run(fx, fx.change({ 'package.json': pkg({ ...s1, [k]: 'rm -rf tests' }) }, { fresh: true }), {}), 'G4')?.files, ['package.json'], k);
  }
  assert.deepEqual(hit(run(fx, fx.change({ 'package.json': pkg({ ...s1, test: 'true' }) }, { fresh: true }), { tests: { all: ['node', '--run', 'test'] } }), 'G4')?.files, ['package.json']);
  assert.deepEqual(hit(run(fx, fx.change({ 'package.json': pkg({ ...s1, pretest: 'exit 0' }) }, { fresh: true }), { tests: { all: ['node', '--run=test'] } }), 'G4')?.files, ['package.json']);
  assert.deepEqual(run(fx, fx.change({ 'package.json': pkg({ ...s1, unit: 'true' }) }, { fresh: true }), { tests: { all: ['node', '--run', 'test'] } }), [], 'unrelated script');
});
test('G4: any dependency pointed at a non-registry specifier fires; a registry version change does not', () => {
  const pkg = (o) => `${JSON.stringify({ name: 'x', devDependencies: { jest: '^29.0.0', lodash: '^4' }, ...o }, null, 2)}\n`;
  const fx = fixture({ 'package.json': pkg({}) });
  const g4 = (o) => hit(run(fx, fx.change({ 'package.json': pkg(o) }, { fresh: true })), 'G4')?.files;
  assert.equal(g4({ devDependencies: { jest: '^30.0.0', lodash: '^4' } }), undefined, 'registry bump');
  assert.equal(g4({ devDependencies: { jest: '^29.0.0', lodash: '^4.17.21' }, dependencies: { react: '18.2.0' } }), undefined, 'registry add/bump');
  assert.deepEqual(g4({ devDependencies: { jest: '^29.0.0', lodash: 'file:./lodash' } }), ['package.json'], 'any package (bin shadowing)');
  for (const o of [{ devDependencies: { jest: 'file:./fake-jest', lodash: '^4' } }, { devDependencies: { jest: 'github:evil/jest', lodash: '^4' } },
    { devDependencies: { jest: 'npm:fake-jest@1', lodash: '^4' } }, { devDependencies: { jest: '../fake', lodash: '^4' } },
    { dependencies: { '@jest/core': 'git+https://x/y.git' } }, { dependencies: { vitest: 'link:../v' } }, { peerDependencies: { mocha: 'https://x/m.tgz' } },
    { resolutions: { '**/jest': 'portal:./j' } }, { overrides: { foo: { jest: 'file:./j' } } }, { overrides: { 'jest@29': 'patch:jest@29#x' } },
    { pnpm: { overrides: { '@playwright/test': 'workspace:*' } } }]) assert.deepEqual(g4(o), ['package.json'], JSON.stringify(o));
});
test('G2: node:test / jasmine idioms fire in test files; an explicit false option does not', () => {
  const fx = fixture({});
  for (const c of ['test("x", { skip: true }, f)', 'test("x", { todo: "later" }, f)', 'it("x", { only: true }, f)', 'it.todo("x")', 'test.todo("x")', 'pending("x")']) {
    assert.deepEqual(hit(run(fx, fx.change({ 'tests/n.test.js': `${c}\n` }, { fresh: true })), 'G2')?.files, ['tests/n.test.js'], c);
  }
  assert.equal(hit(run(fx, fx.change({ 'tests/n.test.js': 'test("x", { skip: false, only: false }, f)\n' }, { fresh: true })), 'G2'), undefined);
  for (const c of ['const t = require("node:test"); t.skip("x")', 'unittest.skip("x")']) {
    assert.deepEqual(hit(run(fx, fx.change({ 'src/h.js': `${c}\n` }, { fresh: true })), 'G2')?.files, ['src/h.js'], c);
  }
});
test('G3: a stub message on the line after the throw fires', () => {
  const fx = fixture({});
  assert.deepEqual(hit(run(fx, fx.change({ 'src/i.js': 'throw new Error(\n  "not implemented");\n' })), 'G3')?.files, ['src/i.js']);
});
test('a runner result without a string stdout or numeric exit code throws (never reads as clean)', () => {
  const fx = fixture({});
  const head = fx.change({ 'tests/z.test.js': 'it.only("x")\n' });
  for (const bad of [{ code: 0, out: undefined }, { code: null, out: '' }, { code: '0', out: '' }]) {
    const git = (...a) => (a.includes('--raw') ? bad : fx.git(...a));
    assert.throws(() => ag.checkDiff({ git, baseRef: BASE, headSha: head, config: {}, specPaths: [] }), /git/, JSON.stringify(bad));
  }
});
test('non-normalised specPaths are refused instead of silently disabling G5', () => {
  const fx = fixture({});
  const head = fx.change({ 'x.js': '1\n' });
  for (const sp of ['./docs/s.md', '../s.md', 'docs/../s.md', '/docs/s.md', 'docs\\s.md', 'docs//s.md', '', 'docs/s.md/', 5]) {
    assert.throws(() => run(fx, head, {}, [sp]), /spec path/, String(sp));
  }
  assert.throws(() => run(fx, head, {}, 'docs/s.md'), /specPaths/);
});
test('repo-local diff.external, textconv and a gitattributes diff driver are never run (on a non-.js file)', () => {
  const fx = fixture({ 'src/impl.py': 'x = 1\n' });
  const mk = (n) => {
    const script = path.join(fx.root, `${n}.sh`);
    fs.writeFileSync(script, `#!/bin/sh\ntouch "${path.join(fx.root, `MARKER-${n}`)}"\ncat "$1" 2>/dev/null\n`, { mode: 0o755 });
    return script;
  };
  fx.sh(fx.work, 'config', 'diff.external', mk('external'));
  fx.sh(fx.work, 'config', 'diff.evil.textconv', mk('textconv'));
  fx.sh(fx.work, 'config', 'diff.evil.command', mk('command'));
  fs.writeFileSync(path.join(fx.work, '.git', 'info', 'attributes'), '*.py diff=evil\n');
  const h = run(fx, fx.change({ 'src/impl.py': 'x = 1\nraise NotImplementedError\n' }));
  for (const n of ['external', 'textconv', 'command']) assert.equal(fs.existsSync(path.join(fx.root, `MARKER-${n}`)), false, `${n} ran`);
  assert.deepEqual(h, [{ id: 'G3', files: ['src/impl.py'] }]);
});

// ---- fix round 2 regressions -----------------------------------------------------------------------------------------------
const pkgJ = (scripts, extra = {}) => `${JSON.stringify({ name: 'x', scripts, ...extra }, null, 2)}\n`;
test('G4: a root script delegating to a workspace makes any scripts change in any package.json a hit', () => {
  const web = { unit: 'jest', test: 'jest' };
  for (const v of ['npm --prefix web run unit', 'cd web && npm run unit', 'npm run unit -w web', 'npm run unit --workspace=web', 'pnpm --filter web unit',
    'yarn workspace web unit', 'pnpm -C web unit', 'npm test --workspaces', 'yarn --cwd web unit', 'npm run $TARGET', 'sh -c "$(cat cmd)"', 'pnpm -r unit']) {
    const fx = fixture({ 'package.json': pkgJ({ test: v }), 'web/package.json': pkgJ(web) });
    assert.deepEqual(hit(run(fx, fx.change({ 'web/package.json': pkgJ({ ...web, build: 'tsc' }) }), { tests: { all: ['npm', 'test'] } }), 'G4')?.files, ['web/package.json'], v);
  }
  for (const all of [['npm', '--prefix', 'web', 'run', 'unit'], ['pnpm', '--filter', 'web', 'unit'], ['npm', 'run', 'unit', '-w', 'web'], ['npm', 'run', 'unit', '--workspace=web'], ['sh', '-c', 'cd web && npm run unit']]) {
    const w2 = { unit: 'jest', other: 'tsc' };
    const fx = fixture({ 'package.json': pkgJ({}), 'web/package.json': pkgJ(w2) });
    assert.deepEqual(hit(run(fx, fx.change({ 'web/package.json': pkgJ({ ...w2, other: 'tsc -b' }) }), { tests: { all } }), 'G4')?.files, ['web/package.json'], all.join(' '));
  }
});
test('G4: any scripts change in a non-root manifest is a hit when another manifest exists; non-script edits stay clean', () => {
  const fx = fixture({ 'package.json': pkgJ({ test: 'turbo run unit' }), 'web/package.json': pkgJ({ unit: 'jest', build: 'tsc' }) });
  assert.deepEqual(hit(run(fx, fx.change({ 'web/package.json': pkgJ({ unit: 'true', build: 'tsc' }) }, { fresh: true }), { tests: { all: ['npm', 'test'] } }), 'G4')?.files, ['web/package.json']);
  assert.deepEqual(hit(run(fx, fx.change({ 'web/package.json': pkgJ({ unit: 'jest', build: 'tsc -b' }) }, { fresh: true }), { tests: { all: ['npm', 'test'] } }), 'G4')?.files, ['web/package.json']);
  assert.deepEqual(run(fx, fx.change({ 'web/package.json': pkgJ({ unit: 'jest', build: 'tsc' }, { description: 'web app' }) }, { fresh: true }), { tests: { all: ['npm', 'test'] } }), []);
});
test('G2: quoted, shorthand and non-literal-false option keys fire; literal false does not; ctx.skip() under any name', () => {
  const fx = fixture({});
  for (const c of ['test("x", { "skip": true }, f)', "test('x', {'skip':true}, f)", 'test("x", {"todo":"later"}, f)', 'test("x", {skip}, f)', 'test("x", { a: 1, only }, f)',
    'test("x", {skip: false || true}, f)', 'test("x", {skip: false ? 0 : 1}, f)', 'test("x", { skip /*c*/ : true }, f)', 'test("x", {skip\n:true}, f)',
    'test("x", {["skip"]:true}, f)', 'test("x", {skip: cond}, f)', 'it("x", {only:1})']) {
    assert.deepEqual(hit(run(fx, fx.change({ 'tests/n.test.js': `${c}\n` }, { fresh: true })), 'G2')?.files, ['tests/n.test.js'], c);
  }
  for (const c of ['test("x", {skip:false}, f)', 'test("x", { skip: false })', 'test("x", { "only": false, todo: false }, f)']) {
    assert.equal(hit(run(fx, fx.change({ 'tests/n.test.js': `${c}\n` }, { fresh: true })), 'G2'), undefined, c);
  }
  for (const c of ['ctx.skip("not ready")', '(t2) => t2.skip()', 'function f(t){ t . skip() }', 'unittest . skip("x")']) {
    assert.deepEqual(hit(run(fx, fx.change({ 'src/h.js': `${c}\n` }, { fresh: true })), 'G2')?.files, ['src/h.js'], c);
  }
  assert.equal(hit(run(fx, fx.change({ 'src/h.js': 'rows.skip(2); q.skip(10)\n' }, { fresh: true })), 'G2'), undefined, 'skip with a numeric count');
});
test('G4: bin shadowing, workspaces, pnpm patches, patch-package and yarn releases fire', () => {
  const fx = fixture({ 'web/package.json': JSON.stringify({ devDependencies: { jest: '^29' } }) });
  const g4 = (files) => hit(run(fx, fx.change(files, { fresh: true })), 'G4')?.files;
  assert.deepEqual(g4({ 'web/package.json': JSON.stringify({ devDependencies: { fakej: 'file:../fake' } }), 'fake/package.json': JSON.stringify({ name: 'fakej', bin: { jest: 'x.js' } }) }),
    ['fake/package.json', 'web/package.json']);
  assert.deepEqual(g4({ 'web/package.json': JSON.stringify({ devDependencies: { jest: '^29' }, workspaces: ['pk/*'] }) }), ['web/package.json']);
  assert.deepEqual(g4({ 'web/package.json': JSON.stringify({ devDependencies: { jest: '^29', Jest: 'file:../f' } }) }), ['web/package.json']);
  assert.deepEqual(g4({ 'web/package.json': JSON.stringify({ devDependencies: { jest: '^29' }, pnpm: { patchedDependencies: { 'jest@29.0.0': 'p/j.patch' } } }) }), ['web/package.json']);
  assert.deepEqual(g4({ 'web/package.json': JSON.stringify({ devDependencies: { jest: '^29' }, packageManager: 'yarn@https://evil/yarn.js' }) }), ['web/package.json']);
  for (const p of ['patches/jest+29.0.0.patch', 'web/patches/x.patch', '.yarn/patches/jest.patch', '.yarn/releases/yarn-4.cjs', '.yarn/plugins/p.cjs', 'pnpm-workspace.yaml', '.pnpmfile.cjs']) {
    assert.deepEqual(g4({ [p]: 'x\n' }), [p], p);
  }
  assert.equal(g4({ 'web/package.json': JSON.stringify({ devDependencies: { jest: '^30' }, packageManager: 'yarn@4.1.0' }) }), undefined, 'registry bump');
});
test('package.json contents are read in one git call; more than 50 changed manifests are a hit without reading', () => {
  const fx = fixture({});
  let calls = 0;
  const git = (...a) => { calls++; return fx.git(...a); };
  const forty = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}/package.json`, `${JSON.stringify({ name: `p${i}`, version: '1.0.0' })}\n`]));
  const head = fx.change(forty, { fresh: true });
  assert.deepEqual(ag.checkDiff({ git, baseRef: BASE, headSha: head, config: {}, specPaths: [] }), []);
  assert.ok(calls <= 9, `${calls} git calls`);
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`p${i}/package.json`, pkgJ({ build: 'tsc' })]));
  calls = 0;
  const h2 = ag.checkDiff({ git, baseRef: BASE, headSha: fx.change(many, { fresh: true }), config: {}, specPaths: [] });
  assert.equal(hit(h2, 'G4').files.length, 51);
  assert.ok(calls <= 7, `${calls} git calls`);
});
test('self-attack round 2: escaped option keys, committed node_modules, Python startup hooks and go.mod replace fire', () => {
  const fx = fixture({ 'go.mod': 'module x\n\ngo 1.22\n' });
  assert.deepEqual(hit(run(fx, fx.change({ 'tests/n.test.js': 'test("x", { "\\u0073kip": true }, f)\n' }, { fresh: true })), 'G2')?.files, ['tests/n.test.js']);
  for (const p of ['node_modules/.bin/jest', 'web/node_modules/vitest/index.js', 'sitecustomize.py', 'src/usercustomize.py', 'lib/x.pth']) {
    assert.deepEqual(hit(run(fx, fx.change({ [p]: 'x\n' }, { fresh: true })), 'G4')?.files, [p], p);
  }
  assert.deepEqual(hit(run(fx, fx.change({ 'go.mod': 'module x\n\ngo 1.22\n\nreplace github.com/stretchr/testify => ./fake\n' }, { fresh: true })), 'G4')?.files, ['go.mod']);
  assert.deepEqual(run(fx, fx.change({ 'go.mod': 'module x\n\ngo 1.23\n' }, { fresh: true })), [], 'go version bump');
});

// ---- fix round 3 regressions -----------------------------------------------------------------------------------------------
const TALL = { tests: { all: ['npm', 'test'] } };
test('Bug 1: a mode-only change of package.json is G4 and never read as {}; a delegating root still reaches the closure', () => {
  for (const v of ['npm --prefix web run unit', 'cd web && npm run unit', 'npm run unit -w web']) {
    const fx = fixture({ 'package.json': pkgJ({ test: v }), 'web/package.json': pkgJ({ unit: 'jest', b: 'tsc' }) });
    fs.chmodSync(path.join(fx.work, 'package.json'), 0o755);
    const h = run(fx, fx.change({ 'web/package.json': pkgJ({ unit: 'exit 0', b: 'tsc' }) }), TALL);
    assert.deepEqual(hit(h, 'G4')?.files, ['package.json', 'web/package.json'], v);
  }
  const fx = fixture({ 'package.json': pkgJ({ test: 'jest' }) });
  fs.chmodSync(path.join(fx.work, 'package.json'), 0o755);
  assert.deepEqual(hit(run(fx, fx.change({}), TALL), 'G4')?.files, ['package.json'], 'mode-only, no hunk');
});
test('D1: package.json that is a symlink, or parses to a non-object, is G4', () => {
  const fx = fixture({ 'web/package.json': JSON.stringify({ devDependencies: { jest: '^29' } }) });
  for (const [files, why] of [[{ 'web/package.json': { link: 'null' }, 'web/null': '{}' }, 'symlink to "null"'], [{ 'web/package.json': { link: '1' }, 'web/1': '{}' }, 'symlink to "1"'],
    [{ 'web/package.json': 'null\n' }, 'null'], [{ 'web/package.json': '[1]\n' }, 'array'], [{ 'web/package.json': '7\n' }, 'number']]) {
    assert.ok(hit(run(fx, fx.change(files, { fresh: true })), 'G4')?.files.includes('web/package.json'), why);
  }
});
test('Bug 2: 200k blank lines in go.mod, package.json, test and source files are scanned in bounded time', () => {
  const blank = '\n'.repeat(200000);
  const fx = fixture({ 'go.mod': 'module x\n', 'package.json': '{"name":"x"}\n' });
  for (const [files, expect] of [[{ 'go.mod': `module x\n${blank}` }, []], [{ 'go.mod': `module x\n${blank}replace a => ./b\n` }, ['G4']],
    [{ 'package.json': `{${blank}"name":"x"}\n` }, []], [{ 'tests/t.test.js': `${blank}it.only("x")\n` }, ['G2']],
    [{ 'src/s.js': `throw new Error("${blank}not implemented")\n` }, []], [{ 'src/s.js': `${blank}x = ctx.${blank}skip${blank}\n` }, []]]) {
    const t0 = Date.now();
    const h = run(fx, fx.change(files, { fresh: true }));
    const ms = Date.now() - t0;
    assert.deepEqual(ids(h), expect, Object.keys(files)[0]);
    assert.ok(ms < 3000, `${Object.keys(files)[0]} took ${ms} ms`);
  }
});
test('D2: project:target script references protect the target script name', () => {
  const fx = fixture({ 'package.json': pkgJ({ test: 'nx run app:unit', unit: 'jest', build: 'tsc' }) });
  assert.deepEqual(hit(run(fx, fx.change({ 'package.json': pkgJ({ test: 'nx run app:unit', unit: 'exit 0', build: 'tsc' }) }, { fresh: true }), TALL), 'G4')?.files, ['package.json']);
  assert.deepEqual(run(fx, fx.change({ 'package.json': pkgJ({ test: 'nx run app:unit', unit: 'jest', build: 'tsc -b' }) }, { fresh: true }), TALL), []);
});
test('D3: wrappers are unwrapped; an unrecognised tool protects every script', () => {
  const s0 = { test: 'jest', build: 'tsc' };
  const fx = fixture({ 'package.json': pkgJ(s0) });
  for (const all of [['env', 'CI=1', 'npm', 'test'], ['cross-env', 'CI=1', 'npm', 'test'], ['npx', 'npm', 'test'], ['corepack', 'pnpm', 'test'], ['time', 'npm', 'test'],
    ['nice', '-n', '10', 'npm', 'test'], ['dotenv', '-e', '.env', '--', 'npm', 'test'], ['npm', 'exec', '--', 'npm', 'test'], ['CI=1', 'npm', 'test']]) {
    assert.deepEqual(hit(run(fx, fx.change({ 'package.json': pkgJ({ ...s0, test: 'exit 0' }) }, { fresh: true }), { tests: { all } }), 'G4')?.files, ['package.json'], all.join(' '));
    assert.deepEqual(run(fx, fx.change({ 'package.json': pkgJ({ ...s0, build: 'tsc -b' }) }, { fresh: true }), { tests: { all } }), [], `${all.join(' ')}: build is not protected`);
  }
  for (const all of [['turbo', 'run', 'test'], ['npx', 'turbo', 'run', 'test'], ['nx', 'run-many', '-t', 'test'], ['lerna', 'run', 'test'], ['make', 'test'], ['npx', 'jest'], ['dotenv', 'npm', 'test']]) {
    assert.deepEqual(hit(run(fx, fx.change({ 'package.json': pkgJ({ ...s0, build: 'tsc -b' }) }, { fresh: true }), { tests: { all } }), 'G4')?.files, ['package.json'], all.join(' '));
  }
});
test('D4: any escape in an option key in a test file is G2', () => {
  const fx = fixture({});
  for (const c of ['test("x", { sk\\u0069p: true }, f)', 'test("x", { "sk\\ip": true }, f)', 'test("x", { \\u{73}kip: true }, f)', "test('x', { 'sk\\x69p': 1 }, f)"]) {
    assert.deepEqual(hit(run(fx, fx.change({ 'tests/n.test.js': `${c}\n` }, { fresh: true })), 'G2')?.files, ['tests/n.test.js'], c);
  }
});
test('D5: optional-chaining, bracket and todo skip forms in non-test files are G2; a numeric count is not', () => {
  const fx = fixture({});
  for (const c of ['ctx?.skip()', 't?.skip("r")', 'ctx.skip?.()', 't["skip"]()', 'ctx?.["todo"]("x")', 'list.todo(item)', 'rows.skip(n)']) {
    assert.deepEqual(hit(run(fx, fx.change({ 'src/h.js': `${c}\n` }, { fresh: true })), 'G2')?.files, ['src/h.js'], c);
  }
  assert.equal(hit(run(fx, fx.change({ 'src/h.js': 'rows.skip(25)\n' }, { fresh: true })), 'G2'), undefined);
});
test('D6: directories.bin, wireit, workspace/task-runner configs, vendor/ and Python framework shadowing are G4', () => {
  const fx = fixture({ 'web/package.json': JSON.stringify({ name: 'w' }) });
  const g4 = (files, config = {}) => hit(run(fx, fx.change(files, { fresh: true }), config), 'G4')?.files;
  assert.deepEqual(g4({ 'web/package.json': JSON.stringify({ name: 'w', directories: { bin: 'b' } }) }), ['web/package.json']);
  assert.deepEqual(g4({ 'web/package.json': JSON.stringify({ name: 'w', wireit: { test: { command: 'true' } } }) }), ['web/package.json']);
  for (const p of ['go.work', 'go.work.sum', 'vendor/github.com/x/assert/a.go', 'pytest/__init__.py', 'src/_pytest/x.py', 'unittest.py', 'hypothesis/__init__.py',
    'turbo.json', 'nx.json', 'apps/web/project.json', 'lerna.json']) assert.deepEqual(g4({ [p]: 'x\n' }), [p], p);
});
test('D6: Makefile / justfile are protected only when a configured command runs make or just', () => {
  const fx = fixture({ Makefile: 'test:\n\tgo test ./...\n', justfile: 'test:\n  go test ./...\n' });
  assert.deepEqual(run(fx, fx.change({ Makefile: 'test:\n\ttrue\n' }, { fresh: true })), [], 'no make in config');
  assert.deepEqual(hit(run(fx, fx.change({ Makefile: 'test:\n\ttrue\n' }, { fresh: true }), { tests: { all: ['make', 'test'] } }), 'G4')?.files, ['Makefile']);
  assert.deepEqual(hit(run(fx, fx.change({ justfile: 'test:\n  true\n', 'mk/t.mk': 'x\n' }, { fresh: true }), { local_checks: [{ name: 'j', command: ['just', 'test'], timeout_s: 60 }] }), 'G4')?.files, ['justfile', 'mk/t.mk']);
});
test('test gaps: suppressBlankEmpty repo config, unreadable root manifest, backtick and delegation in a root-only repo', () => {
  const dj = (o) => JSON.stringify(o, null, 2).replace('{\n', '{\n\n');
  let fx = fixture({ 'package.json': dj({ name: 'x', devDependencies: { jest: '^29' } }) });
  fx.sh(fx.work, 'config', 'diff.suppressBlankEmpty', 'true');
  assert.deepEqual(run(fx, fx.change({ 'package.json': dj({ name: 'x', devDependencies: { jest: '^30' } }) }, { fresh: true })), [], 'blank context line read correctly');
  assert.deepEqual(hit(run(fx, fx.change({ 'package.json': dj({ name: 'x', devDependencies: { jest: 'file:./j' } }) }, { fresh: true })), 'G4')?.files, ['package.json']);
  fx = fixture({ 'package.json': '{ not json', 'web/package.json': pkgJ({ unit: 'jest' }) });
  assert.deepEqual(hit(run(fx, fx.change({ 'web/package.json': pkgJ({ unit: 'jest' }, { description: 'd' }) }), TALL), 'G4')?.files, ['web/package.json'], 'unreadable root');
  for (const v of ['`echo jest`', 'npm run $T', 'npm --prefix web run unit', 'cd web && npm run unit', 'pnpm -r unit', 'yarn workspace web unit']) {
    fx = fixture({ 'package.json': pkgJ({ test: v, build: 'tsc' }) });
    assert.deepEqual(hit(run(fx, fx.change({ 'package.json': pkgJ({ test: v, build: 'tsc -b' }) }), TALL), 'G4')?.files, ['package.json'], v);
  }
  fx = fixture({ 'package.json': pkgJ({ unit: 'jest', other: 'tsc' }) });
  for (const all of [['npm', '--prefix', 'web', 'run', 'unit'], ['npm', 'run', 'unit', '--workspace=web'], ['sh', '-c', 'npm run unit']]) {
    assert.deepEqual(hit(run(fx, fx.change({ 'package.json': pkgJ({ unit: 'jest', other: 'tsc -b' }) }, { fresh: true }), { tests: { all } }), 'G4')?.files, ['package.json'], all.join(' '));
  }
});
test('a non-string dependency value is G4; more than 500 manifests in the head tree is G4', () => {
  let fx = fixture({ 'package.json': JSON.stringify({ devDependencies: { jest: '^29' } }) });
  assert.deepEqual(hit(run(fx, fx.change({ 'package.json': JSON.stringify({ devDependencies: { jest: ['file:./j'] } }) })), 'G4')?.files, ['package.json']);
  const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`p${i}/package.json`, '{"name":"p"}\n']));
  fx = fixture(many);
  assert.deepEqual(hit(run(fx, fx.change({ 'p0/package.json': '{"name":"p","description":"d"}\n' })), 'G4')?.files, ['p0/package.json']);
  assert.deepEqual(run(fx, fx.change({ 'p0/package.json': null, 'p1/package.json': null, 'p2/package.json': '{"name":"p","description":"d"}\n' }, { fresh: true })), [], '499 manifests: under the cap');
});
test('mutation survivors: added symlink manifest, project:target in argv, driver running from a subdirectory', () => {
  let fx = fixture({ 'web/{}': 'x\n' });
  assert.deepEqual(hit(run(fx, fx.change({ 'web/package.json': { link: '{}' } })), 'G4')?.files, ['web/package.json'], 'new symlink whose target text parses as {}');
  fx = fixture({ 'package.json': pkgJ({ 'app:unit': 'jest', unit: 'jest', build: 'tsc' }) });
  const cfg = { tests: { all: ['npm', 'run', 'app:unit'] } };
  assert.deepEqual(hit(run(fx, fx.change({ 'package.json': pkgJ({ 'app:unit': 'jest', unit: 'exit 0', build: 'tsc' }) }, { fresh: true }), cfg), 'G4')?.files, ['package.json']);
  assert.deepEqual(run(fx, fx.change({ 'package.json': pkgJ({ 'app:unit': 'jest', unit: 'jest', build: 'tsc -b' }) }, { fresh: true }), cfg), []);
  fx = fixture({ 'web/package.json': pkgJ({ unit: 'jest' }), 'lib/package.json': pkgJ({ x: 'jest' }), 'docs/readme.txt': 'x\n' });
  const head = fx.change({ 'web/package.json': pkgJ({ unit: 'exit 0' }) });
  const sub = (...a) => { const r = spawnSync('git', a, { cwd: path.join(fx.work, 'docs'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  assert.deepEqual(ag.checkDiff({ git: sub, baseRef: BASE, headSha: head, config: {}, specPaths: [] }), [{ id: 'G4', files: ['web/package.json'] }]);
});
