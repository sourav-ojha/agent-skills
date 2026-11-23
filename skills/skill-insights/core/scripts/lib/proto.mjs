// Minimal schemaless protobuf reader (wire format only). Pure; no I/O. Never throws: malformed input returns null.
// A message is a list of [fieldNumber, wireType, value]; wireType 'v' = varint (BigInt), 'b' = bytes (Uint8Array).
export function decode(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let r = 0n; let s = 0n;
    for (;;) {
      if (i >= buf.length || s > 63n) return null;
      const b = buf[i++];
      r |= BigInt(b & 127) << s;
      if (!(b & 128)) return r;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const tag = varint();
    if (tag === null) return null;
    const f = Number(tag >> 3n); const w = Number(tag & 7n);
    if (f === 0) return null;
    if (w === 0) { const v = varint(); if (v === null) return null; out.push([f, 'v', v]); }
    else if (w === 1) { if (i + 8 > buf.length) return null; i += 8; }
    else if (w === 5) { if (i + 4 > buf.length) return null; i += 4; }
    else if (w === 2) {
      const l = varint();
      if (l === null || i + Number(l) > buf.length) return null;
      out.push([f, 'b', buf.subarray(i, i + Number(l))]); i += Number(l);
    } else return null;
  }
  return out;
}
export const first = (msg, f) => msg?.find((x) => x[0] === f)?.[2];
export const all = (msg, f) => (msg ?? []).filter((x) => x[0] === f).map((x) => x[2]);
export const sub = (msg, f) => { const b = first(msg, f); return b instanceof Uint8Array ? decode(b) : null; };
export const str = (msg, f) => { const b = first(msg, f); return b instanceof Uint8Array ? Buffer.from(b).toString('utf8') : undefined; };
export const int = (msg, f) => { const v = first(msg, f); return typeof v === 'bigint' ? Number(v) : undefined; };
