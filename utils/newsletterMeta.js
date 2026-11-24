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

async function fetchChannelMeta(sock, input) {
  const p = parseInput(input);
  if (!p) throw new Error('Valid WhatsApp Channel link, invite code ya newsletter JID dein.');
  if (typeof sock.newsletterMetadata !== 'function') {
    throw new Error('Is Baileys connection mein newsletterMetadata nahi hai (Baileys 7.0.0-rc ya naya chahiye).');
  }
  const raw = await sock.newsletterMetadata(p.type, p.key);
  const meta = normalizeMeta(raw);
  if (!meta) throw new Error('Channel nahi mila (link galat hai ya channel hata diya gaya hai).');
  return meta;
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

module.exports = { normalizeMeta, parseInput, fetchChannelMeta, serverIdsFrom };
