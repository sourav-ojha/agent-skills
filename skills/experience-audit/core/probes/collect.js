() => {
  // Read-only snapshot of the rendered page for experience-audit. Returns JSON-safe data; changes nothing in the page.
  // Run it with the browser's "evaluate" tool at each viewport, save the result under .experience/evidence/, then: ea.mjs analyze ... --file <result>.
  const r = (n) => Math.round(n);
  const vis = (el) => { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const sel = (el) => { if (!el || !el.tagName) return ''; if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`; const c = [...el.classList].filter((x) => !/^(css|sc|jsx|_)|\d{3,}/.test(x)).slice(0, 2).join('.'); return el.tagName.toLowerCase() + (c ? `.${c}` : ''); };
  const text = (el) => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const abs = (b) => ({ x: r(b.left + scrollX), y: r(b.top + scrollY), w: r(b.width), h: r(b.height) });
  const area = (el) => el.closest('footer,[role=contentinfo]') ? 'footer' : el.closest('nav,[role=navigation],header') ? 'nav' : el.closest('main,[role=main]') ? 'main' : 'other';
  const doc = document.documentElement;
  const head = {
    title: document.title || '',
    description: (document.querySelector('meta[name=description]') || {}).content || '',
    canonical: (document.querySelector('link[rel=canonical]') || {}).href || '',
    robots: (document.querySelector('meta[name=robots]') || {}).content || '',
    lang: doc.getAttribute('lang') || '',
    viewportMeta: !!document.querySelector('meta[name=viewport]'),
    h1: [...document.querySelectorAll('h1')].filter(vis).map(text).slice(0, 5),
    jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent.slice(0, 20000)).slice(0, 10),
    hreflang: [...document.querySelectorAll('link[rel=alternate][hreflang]')].map((l) => l.hreflang).slice(0, 20),
  };
  const links = [...document.querySelectorAll('a')].filter(vis).slice(0, 400).map((a) => ({ href: a.getAttribute('href') || '', hasHref: a.hasAttribute('href'), text: text(a), aria: !!a.getAttribute('aria-label'), rel: a.rel || '', area: area(a) }));
  const imgs = [...document.querySelectorAll('img')].filter(vis);
  const images = { total: imgs.length, noAlt: imgs.filter((i) => !i.hasAttribute('alt')).slice(0, 20).map((i) => ({ sel: sel(i), src: (i.currentSrc || i.src || '').slice(0, 120) })) };
  const taps = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button]')].filter(vis).map((e) => { const b = e.getBoundingClientRect(); return { sel: sel(e), w: r(b.width), h: r(b.height), text: text(e).slice(0, 30) }; }).filter((t) => t.w < 24 || t.h < 24).slice(0, 30);
  const isContent = (e) => ['IMG', 'SVG', 'CANVAS', 'VIDEO', 'PICTURE', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(e.tagName.toUpperCase()) || [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || getComputedStyle(e).backgroundImage !== 'none';
  const contentExtent = (root) => { let top = null, bottom = null, n = 0; for (const e of root.querySelectorAll('*')) { if (++n > 600) break; if (!isContent(e) || !vis(e)) continue; const b = e.getBoundingClientRect(); const t = b.top + scrollY, bt = b.bottom + scrollY; top = top === null ? t : Math.min(top, t); bottom = bottom === null ? bt : Math.max(bottom, bt); } if (top === null && isContent(root) && vis(root)) { const b = root.getBoundingClientRect(); top = b.top + scrollY; bottom = b.bottom + scrollY; } return top === null ? { top: null, bottom: null } : { top: r(top), bottom: r(bottom) }; };
  const rows = [];
  for (const el of document.querySelectorAll('body *')) {
    if (rows.length >= 40) break;
    const s = getComputedStyle(el);
    if (!/flex|grid/.test(s.display) || !vis(el)) continue;
    const kids = [...el.children].filter(vis);
    if (kids.length < 2) continue;
    const boxes = kids.map((k) => abs(k.getBoundingClientRect()));
    const side = boxes.every((b, i) => i === 0 || (b.x >= boxes[i - 1].x + boxes[i - 1].w - 2 && b.y < boxes[0].y + boxes[0].h && b.y + b.h > boxes[0].y));
    if (!side) continue;
    rows.push({ sel: sel(el), display: s.display, rect: abs(el.getBoundingClientRect()), children: kids.map((k, i) => { const ext = contentExtent(k); return { sel: sel(k), rect: boxes[i], contentTop: ext.top, contentBottom: ext.bottom }; }) });
  }
  const main = document.querySelector('main,[role=main]') || document.body;
  const sections = [...main.children].filter(vis).map((e) => ({ sel: sel(e), rect: abs(e.getBoundingClientRect()) })).filter((s) => s.rect.h > 40).slice(0, 40);
  const ft = document.querySelector('footer,[role=contentinfo]');
  const footer = ft ? (() => {
    const fl = [...ft.querySelectorAll('a')].filter(vis).map((a) => ({ text: text(a), href: a.getAttribute('href') || '' }));
    const groups = []; const heads = [...ft.querySelectorAll('h2,h3,h4,h5,h6,[role=heading],strong,dt,summary')].filter(vis);
    for (const h of heads.slice(0, 12)) { const box = h.closest('div,section,nav,ul,li,details') || h.parentElement; const c = box ? [...box.querySelectorAll('a')].filter(vis).length : 0; groups.push({ heading: text(h).slice(0, 40), count: c }); }
    return { present: true, sel: sel(ft), rect: abs(ft.getBoundingClientRect()), links: fl.slice(0, 200), groups };
  })() : { present: false, links: [], groups: [] };
  const navLinks = [...document.querySelectorAll('nav a,[role=navigation] a,header a')].filter(vis).map((a) => ({ text: text(a), href: a.getAttribute('href') || '' })).slice(0, 100);
  return { v: 1, url: location.href, route: location.pathname || '/', viewport: { w: innerWidth, h: innerHeight }, doc: { scrollW: doc.scrollWidth, clientW: doc.clientWidth }, head, links, images, taps, rows, sections, footer, nav: { links: navLinks } };
}
