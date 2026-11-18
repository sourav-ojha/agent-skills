// Deterministic checks over snapshots produced by core/probes/collect.js. Pure functions, zero dependencies.
// Every check returns finding candidates: { rule, route, selector, category, kind, severity, effort, title, group, evidence, proposed_fix, acceptance }.
// Thresholds come from config (core/config.default.json); results are candidates a person confirms, not verdicts.
import { createHash } from 'node:crypto';

const G = {
  title: 'https://developers.google.com/search/docs/appearance/title-link',
  canonical: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls',
  links: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable',
  js: 'https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics',
  robots: 'https://developers.google.com/search/docs/crawling-indexing/robots/intro',
  sitemap: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap',
  sd: 'https://developers.google.com/search/docs/appearance/structured-data/sd-policies',
  mobile: 'https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing',
  wcagTarget: 'WCAG 2.2 SC 2.5.8 Target Size (Minimum)',
};

export const shortHash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
const gwt = (g, w, t) => `Given ${g}, when ${w}, then ${t}`;
const pct = (n) => `${Math.round(n * 100)}%`;
const mk = (base) => ({ effort: 'S', ...base });

// ---------- layout ----------
export function layoutChecks(snap, cfg) {
  const t = cfg.thresholds, route = snap.route || '/', vp = snap.viewport?.w;
  const out = [];
  if (snap.doc && snap.doc.scrollW > snap.doc.clientW + 1) {
    out.push(mk({ rule: 'layout.overflow-x', route, selector: 'html', category: 'layout', kind: 'measured', severity: 'High', effort: 'M',
      title: `Page scrolls horizontally at ${vp}px (content ${snap.doc.scrollW}px wide, viewport ${snap.doc.clientW}px)`,
      group: 'layout:overflow', evidence: { tool: 'collect.js', viewport: vp, value: { scrollWidth: snap.doc.scrollW, clientWidth: snap.doc.clientW } },
      proposed_fix: 'Find the element wider than the viewport and constrain it (max-width, wrapping, or overflow handling).',
      acceptance: [gwt(`the page at ${vp}px wide`, 'it loads', 'scrollWidth is not greater than clientWidth')] }));
  }
  for (const row of snap.rows || []) {
    const H = row.rect.h;
    if (H < t.imbalance_min_row_px) continue;
    const spans = row.children.map((c) => {
      const used = c.contentTop === null || c.contentTop === undefined ? 0 : Math.max(0, c.contentBottom - c.contentTop);
      return { c, used, fill: used / H };
    });
    const full = spans.some((s) => s.fill >= 0.8);
    if (!full) continue;
    for (const s of spans) {
      const share = s.c.rect.w / row.rect.w;
      const empty = H - s.used;
      if (s.fill < t.imbalance_max_fill && empty >= t.imbalance_min_empty_px && share >= t.imbalance_min_share) {
        const tall = spans.find((x) => x.fill >= 0.8).c;
        out.push(mk({ rule: 'layout.column-imbalance', route, selector: s.c.sel, category: 'layout', kind: 'measured', severity: s.fill < 0.35 ? 'Medium' : 'Low',
          title: `Empty space beside ${tall.sel}: ${s.c.sel} fills ${pct(s.fill)} of a ${H}px row at ${vp}px (candidate)`,
          group: `layout:${row.sel}`, evidence: { tool: 'collect.js', viewport: vp, value: { rowHeight: H, columnContentHeight: s.used, fill: Number(s.fill.toFixed(2)), emptyPx: empty, columnShare: Number(share.toFixed(2)) } },
          proposed_fix: 'Rebalance the row: align or sticky-position the short column, let it share the space (stack the panel, resize the media box), or remove the fixed height that stretches it.',
          acceptance: [gwt(`the page at ${vp}px wide with the row ${row.sel} expanded`, 'it is measured', `no column in the row fills less than ${pct(t.imbalance_max_fill)} of the row height`)] }));
      }
    }
  }
  const secs = (snap.sections || []).slice().sort((a, b) => a.rect.y - b.rect.y);
  const gaps = [];
  for (let i = 1; i < secs.length; i++) gaps.push({ gap: secs[i].rect.y - (secs[i - 1].rect.y + secs[i - 1].rect.h), at: secs[i].sel });
  if (gaps.length >= 3) {
    const sorted = gaps.map((g) => g.gap).sort((a, b) => a - b);
    const median = Math.max(sorted[Math.floor(sorted.length / 2)], 1);
    for (const g of gaps) {
      if (g.gap >= t.section_gap_min_px && g.gap > median * t.section_gap_multiplier) {
        out.push(mk({ rule: 'layout.section-gap', route, selector: g.at, category: 'layout', kind: 'measured', severity: 'Low',
          title: `Unusually large vertical gap (${g.gap}px, median ${median}px) before ${g.at} at ${vp}px (candidate)`,
          group: 'layout:spacing', evidence: { tool: 'collect.js', viewport: vp, value: { gap: g.gap, median } },
          proposed_fix: 'Use the spacing scale between sections; remove stray margins or empty containers.',
          acceptance: [gwt(`the page at ${vp}px wide`, 'section gaps are measured', `no gap exceeds ${t.section_gap_multiplier}x the median`)] }));
      }
    }
  }
  const small = (snap.taps || []).filter((x) => x.w < t.tap_target_min_px || x.h < t.tap_target_min_px);
  if (small.length) {
    out.push(mk({ rule: 'a11y.target-size', route, selector: small[0].sel, category: 'a11y', kind: 'rule', severity: 'Medium', effort: 'M',
      title: `${small.length} interactive element(s) smaller than ${t.tap_target_min_px}x${t.tap_target_min_px}px at ${vp}px`,
      group: 'a11y:target-size', evidence: { tool: 'collect.js', cite: G.wcagTarget, viewport: vp, value: small.slice(0, 5).map((x) => `${x.sel} ${x.w}x${x.h}`) },
      proposed_fix: 'Enlarge the hit area (padding or min-size) or add spacing so each target meets the minimum.',
      acceptance: [gwt('the interactive elements listed', 'their rendered size is measured', `each is at least ${t.tap_target_min_px}x${t.tap_target_min_px}px or has enough spacing`)] }));
  }
  const noAlt = snap.images?.noAlt || [];
  if (noAlt.length) {
    out.push(mk({ rule: 'a11y.image-alt', route, selector: noAlt[0].sel, category: 'a11y', kind: 'rule', severity: 'Medium',
      title: `${noAlt.length} image(s) without an alt attribute`, group: 'a11y:image-alt',
      evidence: { tool: 'collect.js', cite: 'WCAG 2.2 SC 1.1.1 Non-text Content', value: noAlt.slice(0, 5).map((x) => x.src || x.sel) },
      proposed_fix: 'Add meaningful alt text, or alt="" for purely decorative images.',
      acceptance: [gwt('the images listed', 'the page is scanned', 'each has an alt attribute')] }));
  }
  return out;
}

// ---------- footer and navigation ----------
const tokens = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
export function footerChecks(snap, cfg, capabilities = []) {
  const t = cfg.thresholds, route = snap.route || '/', f = snap.footer || { present: false, links: [], groups: [] };
  const out = [];
  if (!f.present) {
    out.push(mk({ rule: 'nav.footer-missing', route, selector: 'footer', category: 'navigation', kind: 'measured', severity: 'Medium', effort: 'M',
      title: 'No footer landmark found', group: 'nav:footer', evidence: { tool: 'collect.js', value: 'no <footer> or role=contentinfo element' },
      proposed_fix: 'Add a footer landmark with grouped links to the main sections and features.',
      acceptance: [gwt('any page', 'the DOM is inspected', 'a <footer> (or role=contentinfo) with links exists')] }));
    return out;
  }
  if (f.links.length < t.footer_min_links) {
    out.push(mk({ rule: 'nav.footer-sparse', route, selector: f.sel, category: 'navigation', kind: 'measured', severity: 'Low',
      title: `Footer has only ${f.links.length} link(s) (threshold ${t.footer_min_links})`, group: 'nav:footer',
      evidence: { tool: 'collect.js', value: { links: f.links.length, threshold: t.footer_min_links } },
      proposed_fix: 'Surface the main sections, key features, docs, pricing and legal pages in the footer.',
      acceptance: [gwt('any page', 'the footer is inspected', `it contains at least ${t.footer_min_links} links`)] }));
  }
  const headed = (f.groups || []).filter((g) => g.heading && g.count > 0).length;
  if (f.links.length >= t.footer_min_links && headed < 2) {
    out.push(mk({ rule: 'nav.footer-ungrouped', route, selector: f.sel, category: 'navigation', kind: 'measured', severity: 'Medium',
      title: `Footer has ${f.links.length} links but ${headed} labelled group(s): links are not organised under headings`, group: 'nav:footer',
      evidence: { tool: 'collect.js', value: { links: f.links.length, labelledGroups: headed } },
      proposed_fix: 'Split the links into labelled columns (for example Product, Resources, Company, Legal).',
      acceptance: [gwt('any page', 'the footer is inspected', 'links sit in at least 2 groups, each under a heading')] }));
  }
  if (capabilities.length) {
    const pool = new Set([...f.links, ...(snap.nav?.links || [])].flatMap((l) => tokens(l.text)));
    const covered = [], missing = [];
    for (const c of capabilities) (tokens(c).some((w) => pool.has(w)) ? covered : missing).push(c);
    if (missing.length / capabilities.length >= t.footer_missing_feature_share) {
      out.push(mk({ rule: 'nav.features-not-surfaced', route, selector: f.sel, category: 'navigation', kind: 'measured', severity: 'Medium', effort: 'M',
        title: `Footer and navigation mention ${covered.length} of ${capabilities.length} product capabilities`, group: 'nav:footer',
        evidence: { tool: 'collect.js', value: { covered, missing } },
        proposed_fix: `Add links for the missing capabilities (${missing.slice(0, 5).join(', ')}) to the footer or navigation, pointing at pages that describe them.`,
        acceptance: [gwt('any page', 'footer and navigation link texts are read', 'every listed capability has at least one link')] }));
    }
  }
  return out;
}

// ---------- SEO ----------
const GENERIC = /^(click here|here|read more|learn more|more|link|this)$/i;
const isHttp = (u) => /^https?:\/\//i.test(u || '');
export function seoChecks(snap, cfg, raw) {
  const route = snap.route || '/', h = snap.head || {}, out = [];
  const prod = cfg.environment === 'production';
  const add = (o) => out.push(mk({ route, category: 'seo', kind: 'rule', ...o, evidence: { tool: 'collect.js', ...o.evidence } }));
  if (!h.title || !h.title.trim()) add({ rule: 'seo.title-missing', selector: 'title', severity: 'High', title: 'Page has no <title>', group: 'seo:head', evidence: { cite: G.title, value: 'empty or missing' }, proposed_fix: 'Add a unique, descriptive <title> to this page.', acceptance: [gwt(`${route}`, 'the head is inspected', 'there is a non-empty, page-specific <title>')] });
  if (!h.description) add({ rule: 'seo.description-missing', selector: 'meta[name=description]', severity: 'Medium', title: 'Page has no meta description', group: 'seo:head', evidence: { cite: G.title, value: 'missing' }, proposed_fix: 'Add a short meta description summarising the page.', acceptance: [gwt(`${route}`, 'the head is inspected', 'a meta description exists')] });
  if (!h.h1 || h.h1.length === 0) add({ rule: 'seo.h1-missing', selector: 'h1', severity: 'Medium', title: 'Page has no <h1>', group: 'seo:head', evidence: { cite: G.title, value: 'no h1 in the rendered DOM' }, proposed_fix: 'Add one clear <h1> describing the page.', acceptance: [gwt(`${route}`, 'the DOM is inspected', 'an <h1> exists')] });
  if (!h.canonical) add({ rule: 'seo.canonical-missing', selector: 'link[rel=canonical]', severity: 'Medium', title: 'No canonical link', group: 'seo:head', evidence: { cite: G.canonical, value: 'missing' }, proposed_fix: 'Add an absolute, self-referencing rel=canonical.', acceptance: [gwt(`${route}`, 'the head is inspected', 'an absolute canonical URL is present')] });
  else if (!isHttp(h.canonical)) add({ rule: 'seo.canonical-relative', selector: 'link[rel=canonical]', severity: 'Medium', title: `Canonical is not an absolute URL (${h.canonical})`, group: 'seo:head', evidence: { cite: G.canonical, value: h.canonical }, proposed_fix: 'Use an absolute canonical URL.', acceptance: [gwt(`${route}`, 'the head is inspected', 'the canonical starts with https://')] });
  else if (snap.url && isHttp(snap.url)) {
    try { if (new URL(h.canonical).host !== new URL(snap.url).host) add({ rule: 'seo.canonical-host', selector: 'link[rel=canonical]', severity: prod ? 'Medium' : 'Info', title: `Canonical points to another host (${new URL(h.canonical).host})${prod ? '' : ' (expected on staging or localhost; check production)'}`, group: 'seo:head', evidence: { cite: G.canonical, value: { page: snap.url, canonical: h.canonical } }, proposed_fix: 'Point the canonical at this site unless the page is deliberately a copy.', acceptance: [gwt(`${route}`, 'the head is inspected', 'the canonical host equals the page host')] }); } catch { /* malformed URL already covered */ }
  }
  if (/noindex/i.test(h.robots || '')) add({ rule: 'seo.noindex', selector: 'meta[name=robots]', severity: prod ? 'Critical' : 'Info', title: prod ? 'Page is noindex on a production audit' : 'Page is noindex (expected on staging; check production separately)', group: 'seo:indexing', evidence: { cite: G.robots, value: h.robots }, proposed_fix: prod ? 'Remove noindex unless the page must stay out of search.' : 'Confirm production does not ship this noindex.', acceptance: [gwt('the production site', 'the robots meta is read', 'indexable pages carry no noindex')] });
  if (!h.lang) add({ rule: 'seo.lang-missing', selector: 'html', severity: 'Low', title: 'The <html> element has no lang attribute', group: 'seo:head', evidence: { cite: 'WCAG 2.2 SC 3.1.1 Language of Page', value: 'missing' }, proposed_fix: 'Set lang on <html>.', acceptance: [gwt(`${route}`, 'the DOM is inspected', 'html has a lang attribute')] });
  if (h.viewportMeta === false) add({ rule: 'seo.viewport-missing', selector: 'meta[name=viewport]', severity: 'Medium', title: 'No viewport meta tag (mobile-first indexing and mobile layout)', group: 'seo:head', evidence: { cite: G.mobile, value: 'missing' }, proposed_fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', acceptance: [gwt(`${route}`, 'the head is inspected', 'a viewport meta tag exists')] });
  for (const raw1 of h.jsonld || []) {
    let j; try { j = JSON.parse(raw1); } catch (e) { add({ rule: 'seo.jsonld-invalid', selector: 'script[type="application/ld+json"]', severity: 'Medium', title: 'JSON-LD block is not valid JSON', group: 'seo:structured-data', evidence: { cite: G.sd, value: String(e.message).slice(0, 120) }, proposed_fix: 'Fix the JSON syntax of the structured data.', acceptance: [gwt(`${route}`, 'JSON-LD is parsed', 'every block is valid JSON')] }); continue; }
    const nodes = Array.isArray(j) ? j : j['@graph'] || [j];
    if (!nodes.some((n) => n && n['@type'])) add({ rule: 'seo.jsonld-no-type', selector: 'script[type="application/ld+json"]', severity: 'Low', title: 'JSON-LD has no @type', group: 'seo:structured-data', evidence: { cite: G.sd, value: 'no @type found' }, proposed_fix: 'Declare the schema.org @type; validate with the Rich Results Test (not verified by this audit).', acceptance: [gwt(`${route}`, 'JSON-LD is parsed', 'a node declares @type')] });
  }
  const links = snap.links || [];
  const nohref = links.filter((l) => !l.hasHref), hash = links.filter((l) => l.hasHref && /^(#|javascript:)/i.test(l.href));
  const empty = links.filter((l) => !String(l.text || '').trim() && !l.aria), generic = links.filter((l) => GENERIC.test(String(l.text || '').trim()));
  if (nohref.length || hash.length) add({ rule: 'seo.links-not-crawlable', selector: 'a', severity: 'Medium', effort: 'M', title: `${nohref.length + hash.length} link(s) without a crawlable href`, group: 'seo:links', evidence: { cite: G.links, value: { noHref: nohref.length, hashOrJs: hash.length } }, proposed_fix: 'Use <a href="/real-path"> for navigation so crawlers can follow it.', acceptance: [gwt(`${route}`, 'links are listed', 'every navigation link has a real href')] });
  if (empty.length) add({ rule: 'seo.anchor-empty', selector: 'a', severity: 'Medium', title: `${empty.length} link(s) with no text or label`, group: 'seo:links', evidence: { cite: G.links, value: empty.slice(0, 5).map((l) => l.href) }, proposed_fix: 'Give each link descriptive text or an aria-label.', acceptance: [gwt(`${route}`, 'links are listed', 'each link has text or an aria-label')] });
  if (generic.length) add({ rule: 'seo.anchor-generic', selector: 'a', severity: 'Low', title: `${generic.length} link(s) with generic text ("click here", "read more")`, group: 'seo:links', evidence: { cite: G.links, value: generic.slice(0, 5).map((l) => `${l.text} -> ${l.href}`) }, proposed_fix: 'Replace with anchor text that names the destination.', acceptance: [gwt(`${route}`, 'links are listed', 'no link uses generic text')] });
  if (raw) {
    const r = typeof raw === 'string' ? extractRaw(raw) : raw;
    const rl = links.filter((l) => l.hasHref).length;
    if (!r.title && h.title) add({ rule: 'seo.js-title-only', selector: 'title', severity: 'Medium', title: 'The <title> exists only after JavaScript runs (missing in raw HTML)', group: 'seo:rendering', evidence: { cite: G.js, value: { raw: null, rendered: h.title } }, proposed_fix: 'Server-render or pre-render the title.', acceptance: [gwt(`${route}`, 'the raw HTML is fetched', 'it already contains the <title>')] });
    if (rl >= 10 && r.links < rl * 0.5) add({ rule: 'seo.js-links-only', selector: 'a', severity: 'High', effort: 'L', title: `Most links appear only after JavaScript runs (raw HTML ${r.links}, rendered ${rl})`, group: 'seo:rendering', evidence: { cite: G.js, value: { rawLinks: r.links, renderedLinks: rl } }, proposed_fix: 'Render navigation and content links on the server or pre-render the page.', acceptance: [gwt(`${route}`, 'the raw HTML is fetched', 'its link count is at least half of the rendered count')] });
    if (!r.h1 && h.h1?.length) add({ rule: 'seo.js-h1-only', selector: 'h1', severity: 'Low', title: 'The <h1> exists only after JavaScript runs', group: 'seo:rendering', evidence: { cite: G.js, value: { raw: false, rendered: h.h1[0] } }, proposed_fix: 'Server-render the main heading.', acceptance: [gwt(`${route}`, 'the raw HTML is fetched', 'it contains an <h1>')] });
  }
  return out;
}

// Small, deliberately limited extraction from raw HTML (no DOM available): presence of title, h1, canonical, description and link count.
export function extractRaw(html) {
  const s = String(html);
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  return {
    title: title && title.trim() ? title.trim() : null,
    description: /<meta[^>]+name=["']description["'][^>]*content=/i.test(s) || /<meta[^>]+content=[^>]*name=["']description["']/i.test(s),
    canonical: /<link[^>]+rel=["']canonical["']/i.test(s),
    h1: /<h1[\s>]/i.test(s),
    links: (s.match(/<a\s[^>]*href=/gi) || []).length,
  };
}

// ---------- site level ----------
export function parseSitemap(xml) { return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]); }
export function parseRobots(text) {
  const out = { disallow: [], allow: [], sitemaps: [] };
  let applies = false;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.replace(/#.*$/, '').match(/^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2];
    if (k === 'user-agent') applies = v === '*';
    else if (k === 'sitemap') out.sitemaps.push(v);
    else if (applies && k === 'disallow' && v) out.disallow.push(v);
    else if (applies && k === 'allow' && v) out.allow.push(v);
  }
  return out;
}
const pathOf = (u) => { try { return new URL(u, 'http://x').pathname || '/'; } catch { return u; } };

export function siteChecks(snaps, cfg, opts = {}) {
  const out = [], t = cfg.thresholds;
  const by = (get) => { const m = new Map(); for (const s of snaps) { const v = (get(s) || '').trim(); if (v) m.set(v, [...(m.get(v) || []), s.route]); } return [...m].filter(([, r]) => r.length > 1); };
  for (const [v, routes] of by((s) => s.head?.title)) out.push(mk({ rule: 'seo.title-duplicate', route: routes[0], selector: 'title', category: 'seo', kind: 'rule', severity: 'Medium', title: `Same <title> on ${routes.length} pages: "${v.slice(0, 60)}"`, group: 'seo:head', evidence: { tool: 'collect.js', cite: G.title, value: routes }, proposed_fix: 'Give each page a unique title.', acceptance: [gwt('the audited pages', 'their titles are compared', 'no two pages share a title')] }));
  for (const [v, routes] of by((s) => s.head?.description)) out.push(mk({ rule: 'seo.description-duplicate', route: routes[0], selector: 'meta[name=description]', category: 'seo', kind: 'rule', severity: 'Low', title: `Same meta description on ${routes.length} pages`, group: 'seo:head', evidence: { tool: 'collect.js', cite: G.title, value: routes }, proposed_fix: 'Write page-specific descriptions.', acceptance: [gwt('the audited pages', 'descriptions are compared', 'no two pages share one')] }));
  const known = new Set(snaps.map((s) => s.route));
  const graph = new Map(snaps.map((s) => [s.route, new Set((s.links || []).filter((l) => l.hasHref && !/^(#|javascript:|mailto:|tel:)/i.test(l.href)).map((l) => pathOf(l.href)))]));
  if (known.has('/')) {
    const depth = new Map([['/', 0]]); const q = ['/'];
    while (q.length) { const r = q.shift(); for (const n of graph.get(r) || []) if (!depth.has(n)) { depth.set(n, depth.get(r) + 1); if (graph.has(n)) q.push(n); } }
    for (const [r, d] of depth) if (d > t.click_depth_max) out.push(mk({ rule: 'seo.click-depth', route: r, selector: 'a', category: 'seo', kind: 'rule', severity: 'Low', effort: 'M', title: `${r} is ${d} clicks from the home page (heuristic limit ${t.click_depth_max}; weak evidence)`, group: 'seo:links', evidence: { tool: 'collect.js', cite: G.links, value: { depth: d } }, proposed_fix: 'Link the page from a section hub, the navigation or the footer.', acceptance: [gwt('the audited pages', 'the link graph is built', `the page is reachable in at most ${t.click_depth_max} clicks`)] }));
  }
  if (opts.sitemap) {
    const urls = parseSitemap(opts.sitemap).map(pathOf);
    const linked = new Set([...graph.values()].flatMap((s) => [...s]));
    for (const u of urls) if (!linked.has(u) && u !== '/') out.push(mk({ rule: 'seo.orphan', route: u, selector: 'a', category: 'seo', kind: 'rule', severity: 'Medium', effort: 'M', title: `${u} is in the sitemap but no audited page links to it (only the ${snaps.length} audited page(s) were checked)`, group: 'seo:links', evidence: { tool: 'collect.js', cite: G.links, value: { audited: snaps.length } }, proposed_fix: 'Add internal links to the page from relevant pages.', acceptance: [gwt('the audited pages', 'links are listed', 'at least one links to the page')] }));
  }
  if (opts.robots !== undefined) {
    const r = parseRobots(opts.robots);
    for (const s of snaps) for (const d of r.disallow) if (d !== '/' ? s.route.startsWith(d) : true) out.push(mk({ rule: 'seo.robots-blocks-page', route: s.route, selector: 'robots.txt', category: 'seo', kind: 'rule', severity: prod(cfg) ? 'High' : 'Info', title: `robots.txt disallows ${d}, which covers an audited page${prod(cfg) ? '' : ' (check production separately)'}`, group: 'seo:indexing', evidence: { tool: 'robots.txt', cite: G.robots, value: { disallow: d } }, proposed_fix: 'Remove the rule unless the page must not be crawled (use noindex to keep a page out of results).', acceptance: [gwt('the production robots.txt', 'it is read', 'no Disallow covers pages meant to rank')] }));
    if (!r.sitemaps.length) out.push(mk({ rule: 'seo.sitemap-directive', route: '/', selector: 'robots.txt', category: 'seo', kind: 'rule', severity: 'Low', title: 'robots.txt has no Sitemap line', group: 'seo:indexing', evidence: { tool: 'robots.txt', cite: G.sitemap, value: 'no Sitemap directive' }, proposed_fix: 'Add a Sitemap: line (submission is only a hint).', acceptance: [gwt('robots.txt', 'it is read', 'it lists the sitemap URL')] }));
  }
  return out;
}
const prod = (cfg) => cfg.environment === 'production';

// ---------- imports from other tools ----------
const AXE_SEV = { critical: 'Critical', serious: 'High', moderate: 'Medium', minor: 'Low' };
export function axeFindings(axe, { route = '/', viewport } = {}) {
  const out = [], ver = axe.testEngine?.version || 'unknown';
  for (const v of axe.violations || []) {
    out.push(mk({ rule: `a11y.axe.${v.id}`, route, selector: v.nodes?.[0]?.target?.join(' ') || 'page', category: 'a11y', kind: 'measured', severity: AXE_SEV[v.impact] || 'Medium', effort: 'M',
      title: `${v.help} (${v.nodes?.length || 0} element(s))`, group: `a11y:${v.id}`, evidence: { tool: `axe-core ${ver}`, viewport, cite: v.helpUrl, value: (v.nodes || []).slice(0, 3).map((n) => (n.target || []).join(' ')) },
      proposed_fix: v.nodes?.[0]?.failureSummary ? String(v.nodes[0].failureSummary).replace(/\s+/g, ' ').slice(0, 300) : `Fix the "${v.id}" violation.`,
      acceptance: [gwt(`${route}`, `axe-core runs with the ${v.id} rule`, 'it reports no violation')] }));
  }
  for (const v of axe.incomplete || []) {
    out.push(mk({ rule: `a11y.axe.${v.id}.review`, route, selector: v.nodes?.[0]?.target?.join(' ') || 'page', category: 'a11y', kind: 'needs-human-check', severity: 'Info',
      title: `Needs a human check: ${v.help} (${v.nodes?.length || 0} element(s))`, group: 'a11y:needs-review', evidence: { tool: `axe-core ${ver}`, viewport, cite: v.helpUrl, value: (v.nodes || []).slice(0, 3).map((n) => (n.target || []).join(' ')) } }));
  }
  return out;
}

export function lighthouseFindings(lh, { route = '/' } = {}) {
  const out = [], ver = lh.lighthouseVersion || 'unknown';
  const catOf = { seo: 'seo', accessibility: 'a11y', performance: 'performance' };
  for (const [cid, cat] of Object.entries(lh.categories || {})) {
    if (!catOf[cid]) continue;
    for (const ref of cat.auditRefs || []) {
      const a = lh.audits?.[ref.id];
      if (!a || a.score === null || a.score === undefined || a.score >= 0.9 || ['informative', 'manual', 'notApplicable'].includes(a.scoreDisplayMode)) continue;
      out.push(mk({ rule: `${catOf[cid] === 'performance' ? 'perf' : catOf[cid]}.lighthouse.${a.id}`, route, selector: 'page', category: catOf[cid], kind: 'measured', severity: 'Medium', effort: 'M',
        title: `${a.title}${a.displayValue ? ` (${a.displayValue})` : ''}`, group: `${catOf[cid]}:lighthouse`, evidence: { tool: `Lighthouse ${ver} (lab data)`, value: { score: a.score, displayValue: a.displayValue || null } },
        proposed_fix: String(a.description || a.title).replace(/\s*\[Learn more\]\([^)]*\)\.?/g, '').replace(/\s+/g, ' ').slice(0, 300),
        acceptance: [gwt(`${route}`, `Lighthouse runs the ${a.id} audit`, 'it scores at least 0.9')] }));
    }
  }
  return out;
}
