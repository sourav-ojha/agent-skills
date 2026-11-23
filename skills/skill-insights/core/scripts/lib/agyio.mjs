// Read agy conversations from disk (SQLite via node:sqlite, Node 22.5+, read-only). The only I/O for the antigravity host.
import fs from 'node:fs';
import path from 'node:path';
import { parseAgySteps } from './agy.mjs';
import { decode, sub, str } from './proto.mjs';

let sqlite;
async function load() {
  if (sqlite) return sqlite;
  try { sqlite = await import('node:sqlite'); } catch { throw new Error('the antigravity host needs Node.js 22.5+ (node:sqlite)'); }
  return sqlite;
}

// A sub-conversation names its parent in the model metadata of its first generation.
function parentOf(db) {
  try {
    const row = db.prepare('select data from gen_metadata order by idx limit 1').get();
    const top = row?.data ? decode(row.data) : null;
    const gen = sub(top, 1);
    for (const [f, , v] of gen ?? []) {
      if (f !== 20 || !(v instanceof Uint8Array)) continue;
      const kv = decode(v);
      if (str(kv, 1) === 'parent_cascade_id') return str(kv, 2) || null;
    }
  } catch { /* no generation metadata */ }
  return null;
}

// -> [{ id, mtime, entries, skippedLines, parent }] for every readable conversation in `dir`.
export async function readConversations(dir) {
  const { DatabaseSync } = await load();
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.db')) continue;
    let db;
    try {
      db = new DatabaseSync(path.join(dir, f), { readOnly: true });
      const rows = db.prepare('select status, error_details, metadata, step_payload from steps order by idx').all()
        .map((r) => ({ status: r.status, error: !!(r.error_details && r.error_details.length), metadata: r.metadata, payload: r.step_payload }));
      out.push({ id: f.replace(/\.db$/, ''), parent: parentOf(db), ...parseAgySteps(rows) });
    } catch { /* unreadable or foreign file: skip */ } finally { try { db?.close(); } catch { /* ignore */ } }
  }
  return out;
}

// conversation id -> workspace folder name, from the CLI's own metadata cache (best effort).
export function workspaces(cliDir) {
  const map = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cliDir, 'cache', 'conversation_metadata.json'), 'utf8'));
    for (const [id, c] of Object.entries(j.conversations ?? {})) {
      const w = c?.summary?.WorkspaceURIs?.[0];
      if (typeof w === 'string') map.set(id, w);
    }
  } catch { /* cache missing */ }
  return map;
}
