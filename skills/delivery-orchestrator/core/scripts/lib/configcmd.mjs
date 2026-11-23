// `deliver config <sub>`: the command logic, kept out of deliver.mjs. Returns an exit code; never calls process.exit.
import { entry, keysOf, nearest, renderExplain, renderDocs, renderList } from './configschema.mjs';

function explain({ args, opt, io }) {
  const file = opt.local ? 'local' : 'project';
  if (opt.docs) { io.out(renderDocs(file)); return 0; }
  if (opt.list) { io.out(opt.json ? JSON.stringify(keysOf(file).map((k) => entry(k, file)), null, 2) : renderList(file)); return 0; }
  const key = args[0];
  if (!key) { io.err('explain needs a key, or --list or --docs'); return 1; }
  const e = entry(key, file);
  if (!e) {
    const near = nearest(key, file, 3);
    io.err(`unknown key "${key}"${near.length ? `; did you mean ${near.join(', ')}?` : ''}`);
    return 1;
  }
  io.out(opt.json ? JSON.stringify(e, null, 2) : renderExplain(e));
  return 0;
}

export async function runConfigCommand({ sub, args = [], opt = {}, root, home, io, tty }) {
  if (sub === 'explain') return explain({ args, opt, io });
  io.err(`config ${sub}: not implemented yet`);
  return 1;
}
