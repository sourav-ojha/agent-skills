// Usage-limit failure classifier (P0.3). Pure: no I/O, no clock unless `now` is not given. Zero dependencies.
// Status: FIXTURES ONLY. Shapes come from documented/observed field names, not from a captured real limit event
// (see docs/factory/spikes/limit-detection.md).

const OTHER = Object.freeze({ kind: 'other', resetAt: null, source: 'none' });
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// Accept an object, an array of stream events, JSON text, JSON-lines text, or plain text.
function toEvents(payload) {
  if (Array.isArray(payload)) return payload.filter(asObj);
  if (asObj(payload)) return [payload];
  if (typeof payload !== 'string' || !payload.trim()) return [];
  try { return toEvents(JSON.parse(payload)); } catch { /* fall through */ }
  const lines = payload.split('\n').map((l) => l.trim()).filter(Boolean);
  const objs = [];
  for (const l of lines) { try { const o = JSON.parse(l); if (asObj(o)) objs.push(o); } catch { /* skip */ } }
  return objs.length ? objs : [{ is_error: true, result: payload }];
}

function kindFromEventType(t) {
  const s = String(t || '').toLowerCase();
  if (!s) return null;
  if (s === 'five_hour' || s.startsWith('five_hour')) return 'session';
  if (s.startsWith('seven_day')) return /opus|sonnet|haiku/.test(s) ? 'model' : 'weekly';
  if (/opus|sonnet|haiku/.test(s)) return 'model';
  return null;
}

function kindFromText(text) {
  const t = String(text || '');
  if (/session limit/i.test(t)) return 'session';
  if (/weekly limit/i.test(t)) return 'weekly';
  if (/\b(?:opus|sonnet)\b[^.\n]{0,20}\blimit/i.test(t)) return 'model';
  if (/rate limit reached/i.test(t)) return 'rate';
  return null;
}

function epochToIso(v) {
  const n = typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n; // seconds vs milliseconds
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// "resets 3:45pm", "resets 6pm", "resets Mon 12:00am" in the process-local timezone; the next such instant after `now`.
export function parseResetText(text, now = new Date()) {
  const m = /resets?\s+(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(String(text || ''));
  if (!m) return null;
  let h = Number(m[2]) % 12;
  if (/p/i.test(m[4])) h += 12;
  const min = m[3] ? Number(m[3]) : 0;
  if (Number(m[2]) < 1 || Number(m[2]) > 12 || min > 59) return null;
  const at = (dayOffset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, min, 0, 0);
  let d;
  if (m[1]) {
    const want = DAYS.indexOf(m[1].toLowerCase());
    let off = (want - now.getDay() + 7) % 7;
    d = at(off);
    if (d <= now) d = at(off + 7);
  } else {
    d = at(0);
    if (d <= now) d = at(1);
  }
  return d.toISOString();
}

const textOf = (e) => [e.result, e.last_assistant_message, e.error_details, e.message, e.text].filter((x) => typeof x === 'string').join('\n');
const limitEvent = (e) => {
  const info = asObj(e.rate_limit_info) || (e.type === 'rate_limit_event' ? e : null) || asObj(e.rate_limit_event);
  if (!info) return null;
  const inner = asObj(info.rate_limit_info) || info;
  // Only a rejected event decides a limit; allowed and allowed_warning (approaching a limit) are ignored.
  return String(inner.status || '').toLowerCase() === 'rejected' ? inner : null;
};

export function classifyFailure(payload, { now = new Date() } = {}) {
  let events;
  try { events = toEvents(payload); } catch { return { ...OTHER }; }
  if (!events.length) return { ...OTHER };

  const failed = events.some((e) => e.is_error === true || e.hook_event_name === 'StopFailure');
  if (!failed) return { ...OTHER };

  const text = events.map(textOf).filter(Boolean).join('\n');
  const status429 = events.some((e) => e.api_error_status === 429 || e.error === 'rate_limit');

  let ev = null;
  for (const e of events) { const i = limitEvent(e); if (i) { ev = i; break; } }

  let kind = null; let source = 'none';
  if (ev) { const k = kindFromEventType(ev.rateLimitType ?? ev.rate_limit_type); if (k) { kind = k; source = 'event'; } }
  if (!kind) { const k = kindFromText(text); if (k) { kind = k; source = 'text'; } }
  if (!kind && status429) { kind = 'rate'; source = 'status'; }
  if (!kind) return { ...OTHER };

  let resetAt = null;
  if (ev) resetAt = epochToIso(ev.resetsAt ?? ev.resets_at ?? ev.reset_at ?? ev.resetAt);
  if (!resetAt) for (const e of events) { resetAt = epochToIso(e.resetsAt ?? e.resets_at ?? e.reset_at); if (resetAt) break; }
  if (!resetAt && kind !== 'rate') resetAt = parseResetText(text, now);
  return { kind, resetAt, source };
}
