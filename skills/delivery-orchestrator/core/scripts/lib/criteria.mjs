// Spec criteria extraction: AC table, EC / ER lists and the optional HTTP contract; a hash over those sections only.
import { createHash } from 'node:crypto';

const SECTIONS = [
  { key: 'ac', re: /^acceptance criteria\b/i },
  { key: 'ec', re: /^edge cases\b/i },
  { key: 'er', re: /^error and failure scenarios\b/i },
  { key: 'contract', re: /^http contract\b/i },
];

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// Heading line plus body of each tracked section; the body ends at the next "## " heading.
function splitSections(specText) {
  const lines = String(specText).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const found = {};
  let cur = null;
  for (const line of lines) {
    const h = /^##\s+(?:\d+\.\s*)?(.+?)\s*$/.exec(line);
    if (h) {
      const s = SECTIONS.find((x) => x.re.test(h[1].trim()));
      cur = s && !found[s.key] ? (found[s.key] = { heading: norm(line), body: [] }) : null;
    } else if (cur) cur.body.push(line);
  }
  return found;
}

export function extractCriteria(specText) {
  const found = splitSections(specText);
  const body = (k) => (found[k] ? found[k].body : []);
  const ac = [];
  for (const line of body('ac')) {
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (/^AC-\d+$/.test(cells[0] ?? '')) ac.push({ id: cells[0], text: norm(cells.slice(1).join(' ')) });
  }
  const list = (k, p) => {
    const out = [];
    const re = new RegExp(`^\\s*[-*]\\s+\\**(${p}-\\d+)\\**\\s*[:.)-]?\\s*(.*)$`);
    for (const line of body(k)) { const m = re.exec(line); if (m) out.push({ id: m[1], text: norm(m[2]) }); }
    return out;
  };
  const contract = [];
  for (const line of body('contract')) {
    const m = /`\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s`?#]*)[^`]*`/i.exec(line);
    if (m) contract.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  const sections = SECTIONS.filter((s) => found[s.key])
    .map((s) => [found[s.key].heading, ...found[s.key].body.map(norm).filter(Boolean)].join('\n')).join('\n');
  return { ac, ec: list('ec', 'EC'), er: list('er', 'ER'), contract, sections };
}

export const criteriaHash = (sections) => `sha256:${createHash('sha256').update(String(sections)).digest('hex')}`;

// git: injected (...argv) => {code,out,err}. Fully qualified ref so a local tag/branch named origin/<base> cannot shadow it.
export function specFromBase(git, base, specPath) {
  const r = git('show', `refs/remotes/origin/${base}:${specPath}`);
  return r.code === 0 ? r.out : null;
}
