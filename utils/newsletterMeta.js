'use strict';
/**
 * utils/newsletterMeta.js — one place that understands what sock.newsletterMetadata() returns.
 *
 * Baileys changed the shape between releases:
 *   • rc.9 and older : flat   { id, name, description, invite, subscribers, creation_time, picture }
 *   • rc.14 (current): RAW GraphQL { id, state:{type}, thread_metadata:{ name:{text}, description:{text}, invite,
 *                      subscribers_count, creation_time, picture:{direct_path}, verification }, viewer_metadata:{ mute, role } }
 * The old code only read the flat shape, so on rc.14 name / description / subscribers / date came out empty.
 */

const txt = (v) => (v && typeof v === 'object' ? (v.text ?? '') : (v ?? ''));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function normalizeMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw.result && typeof raw.result === 'object' && raw.result.id ? raw.result : raw;
  if (!r.id) return null;
  const t = r.thread_metadata || {};
  const pic = r.picture || t.picture || null;
  const direct = pic && (pic.directPath || pic.direct_path);
  return {
    id: String(r.id),
    name: String(txt(r.name) || txt(t.name) || r.subject || ''),
    description: String(txt(r.description) || txt(t.description) || ''),
    invite: r.invite || t.invite || '',
    subscribers: num(r.subscribers ?? r.subscribers_count ?? t.subscribers_count ?? r.subscriberCount),
    created: num(r.creation_time ?? r.creationTime ?? t.creation_time),
    verified: String(r.verification || t.verification || '').toUpperCase() === 'VERIFIED',
    state: (r.state && (r.state.type || r.state)) || '',
    role: r.viewer_metadata?.role || '',
    muted: r.viewer_metadata?.mute || '',
    pictureUrl: typeof pic === 'string' ? pic : (direct ? `https://pps.whatsapp.net${direct}` : ''),
  };
}

/** accepts an invite code, a whatsapp.com/channel link or a 120363…@newsletter jid */
function parseInput(input) {
  const s = String(input || '').trim();
  if (/^\d+@newsletter$/.test(s)) return { type: 'jid', key: s };
  const m = s.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i) || s.match(/\/channel\/([A-Za-z0-9_-]+)/i);
  if (m) return { type: 'invite', key: m[1] };
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return { type: 'invite', key: s };
  return null;
}

// ── Fallback for when WhatsApp answers the metadata query in BINARY (protobuf-like) instead of JSON ─────────────
// Symptom in chat:  Unexpected token '…', "�1203634"... is not valid JSON   (Baileys rc.14 does JSON.parse on the reply).
// We send the same query ourselves, read the raw bytes, try JSON first, then a schema-less protobuf walk that pulls out the
// channel id / invite code / name / description. Unknown layouts are still logged so the format can be fixed quickly.
const METADATA_QUERY_ID = '6563316087068696';   // same id Baileys rc.14 uses (Types/Mex.js → QueryIds.METADATA)

function readVarint(buf, pos) {
  let result = 0, shift = 0, i = pos;
  while (i < buf.length && shift < 49) {
    const b = buf[i++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) return { value: result, next: i };
    shift += 7;
  }
  return null;
}
const isPrintableUtf8 = (b) => {
  let s; try { s = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (_) { return null; }
  if (!s.length) return null;
  let bad = 0; for (const ch of s) { const c = ch.codePointAt(0); if (c < 32 && c !== 10 && c !== 13 && c !== 9) bad++; }
  return bad === 0 ? s : null;
};
/** generic protobuf walk → flat list [{ path, kind: 'str'|'num', value }] (never throws) */
function walkProto(buf, path = '', depth = 0, out = []) {
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos); if (!tag) break; pos = tag.next;
    const field = Math.floor(tag.value / 8), wt = tag.value % 8, here = path + '/' + field;
    if (wt === 0) { const v = readVarint(buf, pos); if (!v) break; pos = v.next; out.push({ path: here, kind: 'num', value: v.value }); }
    else if (wt === 2) {
      const len = readVarint(buf, pos); if (!len) break; pos = len.next;
      if (len.value < 0 || pos + len.value > buf.length) break;
      const chunk = buf.subarray(pos, pos + len.value); pos += len.value;
      const str = isPrintableUtf8(chunk);
      let nested = false;
      if (depth < 5 && chunk.length > 2 && !(str && /^[\w@.\-: ]{1,}$/.test(str))) {
        const before = out.length;
        walkProto(chunk, here, depth + 1, out);
        nested = out.length > before;
      }
      if (!nested && str != null) out.push({ path: here, kind: 'str', value: str });
    }
    else if (wt === 1) { pos += 8; } else if (wt === 5) { pos += 4; } else break;   // fixed64 / fixed32 / unknown wire type
  }
  return out;
}
/** build a meta object from whatever the protobuf walk found */
function metaFromProto(buf) {
  const items = walkProto(buf);
  const strs = items.filter(i => i.kind === 'str').map(i => i.value.trim()).filter(Boolean);
  const idStr = strs.find(v => /^\d{15,}(@newsletter)?$/.test(v));
  if (!idStr) return null;
  const rest = strs.filter(v => v !== idStr);
  const invite = rest.find(v => /^0029V[A-Za-z0-9_-]{8,}$/.test(v)) || '';
  const others = rest.filter(v => v !== invite && !/^\d+$/.test(v) && !/^(ACTIVE|VERIFIED|UNVERIFIED|GUEST|SUBSCRIBER|OWNER|ADMIN|ON|OFF|NEWSLETTER|INVITE|JID)$/i.test(v) && !/^https?:\/\//.test(v));
  const nums = items.filter(i => i.kind === 'num').map(i => i.value);
  const stamp = nums.find(n => n > 1.4e9 && n < 2.2e9);          // unix seconds → creation time
  const subs = nums.filter(n => n >= 0 && n < 1e9 && n !== stamp).sort((a, b) => b - a)[0];
  return {
    id: idStr.includes('@') ? idStr : `${idStr}@newsletter`,
    name: others[0] || '',
    description: others.slice(1).sort((a, b) => b.length - a.length)[0] || '',
    invite, subscribers: subs != null ? subs : null, created: stamp || null,
    verified: strs.some(v => /^VERIFIED$/i.test(v)), state: '', role: '', muted: '', pictureUrl: '', _from: 'binary-reply',
  };
}
function childNode(node, tag) { return Array.isArray(node?.content) ? node.content.find(c => c && c.tag === tag) : null; }

/** raw query → { meta|null, raw: Buffer|null } — used only when the normal Baileys call cannot parse the reply */
async function rawMetadata(sock, type, key) {
  const variables = { fetch_creation_time: true, fetch_full_image: true, fetch_viewer_metadata: true, input: { key, type: String(type).toUpperCase() } };
  const gen = typeof sock.generateMessageTag === 'function' ? sock.generateMessageTag() : undefined;
  const res = await sock.query({
    tag: 'iq', attrs: { ...(gen ? { id: gen } : {}), type: 'get', to: 's.whatsapp.net', xmlns: 'w:mex' },
    content: [{ tag: 'query', attrs: { query_id: METADATA_QUERY_ID }, content: Buffer.from(JSON.stringify({ variables }), 'utf-8') }],
  });
  const child = childNode(res, 'result');
  const raw = child && child.content != null ? Buffer.from(child.content) : null;
  if (!raw || !raw.length) return { meta: null, raw: null };
  try {                                              // 1) JSON (the normal format)
    const j = JSON.parse(raw.toString('utf-8'));
    const meta = normalizeMeta(j?.data?.xwa2_newsletter_metadata || j?.data || j);
    if (meta) return { meta, raw };
  } catch (_) { /* not JSON */ }
  return { meta: metaFromProto(raw), raw };         // 2) binary
}

/** printable summary of a raw reply (for `.newsletter debug <link>`) */
function describeRaw(raw) {
  if (!raw) return '(empty reply)';
  const items = walkProto(raw);
  const lines = items.slice(0, 40).map(i => `${i.path} ${i.kind === 'num' ? '#' : '"'}${i.kind === 'num' ? i.value : String(i.value).slice(0, 80)}${i.kind === 'num' ? '' : '"'}`);
  return `bytes=${raw.length} head=${raw.subarray(0, 24).toString('hex')}\n` + (lines.join('\n') || '(no readable fields)');
}

async function fetchChannelMeta(sock, input, opts = {}) {
  const p = parseInput(input);
  if (!p) throw new Error('Valid WhatsApp Channel link, invite code ya newsletter JID dein.');
  if (typeof sock.newsletterMetadata !== 'function') {
    throw new Error('Is Baileys connection mein newsletterMetadata nahi hai (Baileys 7.0.0-rc ya naya chahiye).');
  }
  let firstErr = null;
  if (!opts.forceRaw) {
    try {
      const raw = await sock.newsletterMetadata(p.type, p.key);
      const meta = normalizeMeta(raw);
      if (meta) return meta;
      firstErr = new Error('Channel nahi mila (link galat hai ya channel hata diya gaya hai).');
    } catch (e) { firstErr = e; }
    // only the "reply is not JSON" failure is rescued here; real errors (not found, rate limit…) are reported as they are
    if (!/JSON|Unexpected token|Unexpected end/i.test(String(firstErr && firstErr.message))) throw firstErr;
  }
  let r;
  try { r = await rawMetadata(sock, p.type, p.key); }
  catch (e) { if (opts.debug) { opts.debug.error = e.message; } throw firstErr || e; }
  if (opts.debug) opts.debug.raw = r.raw;
  if (r.raw) console.log('[newsletter] binary reply parsed via fallback:', describeRaw(r.raw).split('\n')[0]);
  if (r.meta) return r.meta;
  throw new Error('Channel ka jawab samajh nahi aaya (WhatsApp ne naye format mein bheja). `.newsletter debug <link>` chalao aur screenshot bhejo.');
}

/**
 * newsletterFetchMessages() on rc.14 returns the RAW binary node (not an array):
 *   <iq><message_updates><messages jid="…"><message server_id="123" …/>…</messages></message_updates></iq>
 * Older versions returned an array of { server_id, … }. Understand both → list of numeric server ids.
 */
function serverIdsFrom(res) {
  const out = [];
  const seen = new Set();
  const add = (v) => { const n = Number(v); if (Number.isFinite(n) && !seen.has(n)) { seen.add(n); out.push(n); } };
  const walk = (node, depth) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
    if (typeof node !== 'object') return;
    if (node.attrs && node.attrs.server_id != null && (node.tag === 'message' || node.tag == null)) add(node.attrs.server_id);
    else if (node.server_id != null) add(node.server_id);
    else if (node.serverId != null) add(node.serverId);
    if (Array.isArray(node.content)) walk(node.content, depth + 1);
    if (Array.isArray(node.messages)) walk(node.messages, depth + 1);
    if (Array.isArray(node.data)) walk(node.data, depth + 1);
  };
  walk(res, 0);
  return out.sort((a, b) => a - b);
}

module.exports = { normalizeMeta, parseInput, fetchChannelMeta, serverIdsFrom, walkProto, metaFromProto, describeRaw, rawMetadata };
