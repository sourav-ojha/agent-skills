import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { layoutChecks, footerChecks, seoChecks, siteChecks, axeFindings, lighthouseFindings, extractRaw, parseRobots, parseSitemap } from '../../skills/experience-audit/core/scripts/lib/checks.mjs';

const CORE = path.join(REPO, 'skills/experience-audit/core');
const cfg = JSON.parse(fs.readFileSync(path.join(CORE, 'config.default.json'), 'utf8'));
const fx = (n) => JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/experience-audit', n), 'utf8'));
const rules = (a) => a.map((x) => x.rule);

// The two snapshots below were captured by core/probes/collect.js in a real browser at 1440px.
test('real snapshot: the empty-panel layout (short media column beside a tall option panel) is flagged', () => {
  const f = layoutChecks(fx('defects-1440.json'), cfg).find((x) => x.rule === 'layout.column-imbalance');
  assert.ok(f, 'column imbalance not detected');
  assert.equal(f.selector, 'div.media');
  assert.equal(f.evidence.value.rowHeight, 624 + 48);
  assert.ok(f.evidence.value.fill < 0.3);
  assert.match(f.title, /candidate/);
  assert.equal(f.kind, 'measured');
  assert.ok(f.acceptance.every((a) => /given.*when.*then/i.test(a)));
});

test('real snapshot: the balanced page and its tidy footer produce no layout or footer findings', () => {
  const g = fx('good-1440.json');
  assert.deepEqual(layoutChecks(g, cfg), []);
  assert.deepEqual(footerChecks(g, cfg), []);
});

test('real snapshot: small targets and a missing alt are reported as rule findings with a cited standard', () => {
  const f = layoutChecks(fx('defects-1440.json'), cfg);
  assert.ok(rules(f).includes('a11y.target-size') && rules(f).includes('a11y.image-alt'));
  assert.ok(f.filter((x) => x.kind === 'rule').every((x) => x.evidence.cite));
});

test('imbalance: no false positive when both columns are similar, the row is short, or the short column is narrow', () => {
  const row = (h, a, b, w1 = 600) => ({ doc: { scrollW: 1000, clientW: 1000 }, viewport: { w: 1000 }, rows: [{ sel: 'r', rect: { x: 0, y: 0, w: 1000, h }, children: [{ sel: 'a', rect: { x: 0, y: 0, w: w1, h }, contentTop: 0, contentBottom: a }, { sel: 'b', rect: { x: w1, y: 0, w: 1000 - w1, h }, contentTop: 0, contentBottom: b }] }] });
  assert.equal(layoutChecks(row(500, 450, 480), cfg).length, 0);
  assert.equal(layoutChecks(row(250, 40, 250), cfg).length, 0, 'short row');
  assert.equal(layoutChecks(row(600, 100, 600, 150), cfg).length, 0, 'narrow column (share < 20%)');
  assert.equal(layoutChecks(row(600, 100, 600), cfg).length, 1);
  assert.equal(layoutChecks(row(600, 100, 120), cfg).length, 0, 'both columns short: the row is simply short, nothing is empty beside something full');
});

test('imbalance severity follows the fill ratio', () => {
  const mk = (a) => ({ viewport: { w: 1000 }, rows: [{ sel: 'r', rect: { x: 0, y: 0, w: 1000, h: 800 }, children: [{ sel: 'a', rect: { x: 0, y: 0, w: 500, h: 800 }, contentTop: 0, contentBottom: a }, { sel: 'b', rect: { x: 500, y: 0, w: 500, h: 800 }, contentTop: 0, contentBottom: 800 }] }] });
  assert.equal(layoutChecks(mk(150), cfg)[0].severity, 'Medium');
  assert.equal(layoutChecks(mk(360), cfg)[0].severity, 'Low');
});

test('horizontal overflow and outlier section gaps', () => {
  const o = layoutChecks({ viewport: { w: 390 }, doc: { scrollW: 520, clientW: 390 } }, cfg);
  assert.deepEqual(rules(o), ['layout.overflow-x']);
  const secs = [0, 100, 200, 300, 800].map((y, i) => ({ sel: `s${i}`, rect: { x: 0, y: i === 4 ? 800 : y, w: 1000, h: 80 } }));
  const g = layoutChecks({ viewport: { w: 1000 }, sections: secs }, cfg);
  assert.deepEqual(rules(g), ['layout.section-gap']);
  assert.equal(g[0].selector, 's4');
});

test('footer: missing, sparse, ungrouped, and feature coverage', () => {
  assert.deepEqual(rules(footerChecks({ footer: { present: false, links: [], groups: [] } }, cfg)), ['nav.footer-missing']);
  const links = (n) => Array.from({ length: n }, (_, i) => ({ text: `Link ${i}`, href: `/l${i}` }));
  assert.deepEqual(rules(footerChecks({ footer: { present: true, sel: 'footer', links: links(3), groups: [] } }, cfg)), ['nav.footer-sparse']);
  assert.deepEqual(rules(footerChecks({ footer: { present: true, sel: 'footer', links: links(12), groups: [] } }, cfg)), ['nav.footer-ungrouped']);
  const f = { footer: { present: true, sel: 'footer', links: [{ text: 'Resize images', href: '/r' }, ...links(9)], groups: [{ heading: 'A', count: 5 }, { heading: 'B', count: 5 }] }, nav: { links: [] } };
  const cov = footerChecks(f, cfg, ['image resize', 'batch export', 'api access', 'team workspaces']);
  assert.deepEqual(rules(cov), ['nav.features-not-surfaced']);
  assert.deepEqual(cov[0].evidence.value.covered, ['image resize']);
  assert.deepEqual(footerChecks(f, cfg, ['image resize', 'resize presets']), []);
});

test('seo: a clean head is quiet; a bare head is reported with cited guidance', () => {
  assert.deepEqual(rules(seoChecks(fx('good-1440.json'), cfg)), ['seo.canonical-host']);
  assert.equal(seoChecks(fx('good-1440.json'), cfg)[0].severity, 'Info', 'staging canonical mismatch is Info');
  assert.equal(seoChecks(fx('good-1440.json'), { ...cfg, environment: 'production' })[0].severity, 'Medium');
  const f = seoChecks(fx('defects-1440.json'), cfg);
  for (const r of ['seo.title-missing', 'seo.description-missing', 'seo.h1-missing', 'seo.canonical-missing', 'seo.lang-missing', 'seo.viewport-missing', 'seo.links-not-crawlable', 'seo.anchor-generic']) assert.ok(rules(f).includes(r), r);
  assert.ok(f.every((x) => x.evidence.cite && x.kind === 'rule'));
});

test('seo: noindex is Info on staging and Critical in production', () => {
  const s = { route: '/', head: { title: 't', description: 'd', canonical: 'https://a.com/', robots: 'noindex, nofollow', lang: 'en', viewportMeta: true, h1: ['x'] }, url: 'https://a.com/' };
  assert.equal(seoChecks(s, cfg).find((x) => x.rule === 'seo.noindex').severity, 'Info');
  assert.equal(seoChecks(s, { ...cfg, environment: 'production' }).find((x) => x.rule === 'seo.noindex').severity, 'Critical');
});

test('seo: JSON-LD syntax and @type, relative canonical, empty anchors', () => {
  const s = { route: '/', url: 'https://a.com/', head: { title: 't', description: 'd', canonical: '/rel', lang: 'en', viewportMeta: true, h1: ['x'], jsonld: ['{bad', '{"@context":"https://schema.org"}'] }, links: [{ href: '/x', hasHref: true, text: '', aria: false }, { href: '/y', hasHref: true, text: '', aria: true }] };
  const r = rules(seoChecks(s, cfg));
  for (const x of ['seo.canonical-relative', 'seo.jsonld-invalid', 'seo.jsonld-no-type', 'seo.anchor-empty']) assert.ok(r.includes(x), x);
  assert.equal(seoChecks(s, cfg).find((x) => x.rule === 'seo.anchor-empty').title.startsWith('1 link'), true, 'aria-label counts as a label');
});

test('seo: raw HTML versus rendered DOM exposes content that exists only after JavaScript', () => {
  const links = Array.from({ length: 14 }, (_, i) => ({ href: `/p${i}`, hasHref: true, text: `P${i}`, aria: false }));
  const s = { route: '/', url: 'https://a.com/', head: { title: 'Rendered title', description: 'd', canonical: 'https://a.com/', lang: 'en', viewportMeta: true, h1: ['H'] }, links };
  const raw = '<html><head></head><body><div id="root"></div><a href="/">x</a></body></html>';
  const r = rules(seoChecks(s, cfg, raw));
  for (const x of ['seo.js-title-only', 'seo.js-links-only', 'seo.js-h1-only']) assert.ok(r.includes(x), x);
  const ssr = '<title>Rendered title</title><h1>H</h1>' + links.map((l) => `<a href="${l.href}">x</a>`).join('');
  assert.deepEqual(rules(seoChecks(s, cfg, ssr)), []);
  assert.deepEqual(extractRaw(ssr), { title: 'Rendered title', description: false, canonical: false, h1: true, links: 14 });
});

test('site: duplicate titles, click depth, orphans from the sitemap, robots blocking', () => {
  const page = (route, title, hrefs) => ({ route, head: { title, description: 'same' }, links: hrefs.map((h) => ({ href: h, hasHref: true, text: 't' })) });
  const snaps = [page('/', 'Home', ['/a']), page('/a', 'Same', ['/b']), page('/b', 'Same', ['/c']), page('/c', 'C', ['/d']), page('/d', 'D', ['/e']), page('/e', 'E', [])];
  const sitemap = '<urlset><url><loc>https://x.com/</loc></url><url><loc>https://x.com/lonely</loc></url><url><loc>https://x.com/a</loc></url></urlset>';
  const robots = 'User-agent: *\nDisallow: /d\n# c\nUser-agent: bot\nDisallow: /e';
  const f = siteChecks(snaps, cfg, { sitemap, robots });
  const r = rules(f);
  assert.ok(r.includes('seo.title-duplicate') && r.includes('seo.description-duplicate'));
  assert.ok(f.some((x) => x.rule === 'seo.click-depth' && x.route === '/e'), 'depth 5 beyond the limit');
  assert.ok(f.some((x) => x.rule === 'seo.orphan' && x.route === '/lonely'));
  assert.ok(!f.some((x) => x.rule === 'seo.orphan' && x.route === '/a'));
  const blocks = f.filter((x) => x.rule === 'seo.robots-blocks-page');
  assert.deepEqual(blocks.map((x) => x.route), ['/d']);
  assert.equal(blocks[0].severity, 'Info', 'staging');
  assert.ok(r.includes('seo.sitemap-directive'));
  assert.deepEqual(parseRobots('User-agent: *\nSitemap: https://x.com/s.xml\nDisallow: /p').sitemaps, ['https://x.com/s.xml']);
  assert.deepEqual(parseSitemap(sitemap), ['https://x.com/', 'https://x.com/lonely', 'https://x.com/a']);
});

test('axe: violations are findings with severity mapping; incomplete results are "needs a human check", never defects', () => {
  const axe = { testEngine: { version: '4.10.0' }, violations: [{ id: 'color-contrast', impact: 'serious', help: 'Elements must have sufficient color contrast', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast', nodes: [{ target: ['.btn'], failureSummary: 'Fix any of the following:\n  contrast 2.1' }] }],
    incomplete: [{ id: 'link-in-text-block', impact: 'serious', help: 'Links must be distinguishable', helpUrl: 'https://x', nodes: [{ target: ['a.x'] }] }] };
  const f = axeFindings(axe, { route: '/p', viewport: 390 });
  assert.equal(f[0].severity, 'High'); assert.equal(f[0].kind, 'measured'); assert.match(f[0].evidence.tool, /axe-core 4\.10\.0/);
  assert.equal(f[1].kind, 'needs-human-check'); assert.equal(f[1].severity, 'Info');
});

test('lighthouse: only scored, non-manual audits below 0.9 become lab-data findings', () => {
  const lh = { lighthouseVersion: '13.0.0', categories: { seo: { auditRefs: [{ id: 'meta-description' }, { id: 'ok' }, { id: 'manual' }] }, performance: { auditRefs: [{ id: 'lcp' }] }, pwa: { auditRefs: [{ id: 'x' }] } },
    audits: { 'meta-description': { id: 'meta-description', title: 'Document has a meta description', score: 0, scoreDisplayMode: 'binary', description: 'Add one. [Learn more](https://x).' }, ok: { id: 'ok', title: 'ok', score: 1, scoreDisplayMode: 'binary' }, manual: { id: 'manual', title: 'm', score: null, scoreDisplayMode: 'manual' }, lcp: { id: 'lcp', title: 'Largest Contentful Paint', score: 0.4, scoreDisplayMode: 'numeric', displayValue: '4.1 s' }, x: { id: 'x', title: 'x', score: 0, scoreDisplayMode: 'binary' } } };
  const f = lighthouseFindings(lh);
  assert.deepEqual(rules(f), ['seo.lighthouse.meta-description', 'perf.lighthouse.lcp']);
  assert.match(f[1].evidence.tool, /lab data/);
});
