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
test('G4: a test-runner dependency pointed at a non-registry specifier fires; a registry version change does not', () => {
  const pkg = (o) => `${JSON.stringify({ name: 'x', devDependencies: { jest: '^29.0.0', lodash: '^4' }, ...o }, null, 2)}\n`;
  const fx = fixture({ 'package.json': pkg({}) });
  const g4 = (o) => hit(run(fx, fx.change({ 'package.json': pkg(o) }, { fresh: true })), 'G4')?.files;
  assert.equal(g4({ devDependencies: { jest: '^30.0.0', lodash: '^4' } }), undefined, 'registry bump');
  assert.equal(g4({ devDependencies: { jest: '^29.0.0', lodash: 'file:./lodash' } }), undefined, 'non-runner package');
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
test('repo-local diff.external, textconv and a gitattributes diff driver are never run', () => {
  const fx = fixture({ 'tests/a.test.js': 'it("a", f)\n' });
  const marker = path.join(fx.root, 'MARKER');
  const script = path.join(fx.root, 'evil.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat "$1" 2>/dev/null\n`, { mode: 0o755 });
  fx.sh(fx.work, 'config', 'diff.external', script);
  fx.sh(fx.work, 'config', 'diff.evil.textconv', script);
  fx.sh(fx.work, 'config', 'diff.evil.command', script);
  fs.writeFileSync(path.join(fx.work, '.git', 'info', 'attributes'), '* diff=evil\n*.js -diff\n');
  const h = run(fx, fx.change({ 'tests/a.test.js': 'it.only("a", f)\n', 'src/s.js': 'todo!()\n' }));
  assert.equal(fs.existsSync(marker), false, 'no driver ran');
  assert.deepEqual(ids(h), ['G1', 'G2', 'G3']);
});
