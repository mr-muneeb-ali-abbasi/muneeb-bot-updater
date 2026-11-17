'use strict';
/**
 * utils/viewOnceStore.js — view-once media ko message AATE HI save kar leta hai (.vv ke liye)
 * ─────────────────────────────────────────────────────────────────────────
 * PROBLEM: WhatsApp ab view-once ko "reply" karne par quotedMessage me media ka url / directPath / mediaKey
 *          nahi deta. Isliye .vv ko "No valid media URL or directPath present in message" milta tha.
 * FIX:     jab view-once message pehli baar bot ko milta hai (usme poori media info hoti hai) tabhi uska media
 *          download karke chhote cache me rakh lete hain. .vv reply karne par message-id se wahi se nikalta hai.
 *
 * Limits (RAM bachane ke liye): max 30 messages, kul 40 MB, 60 minute baad apne aap hat jata hai.
 */
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const TTL_MS        = 60 * 60 * 1000;
const MAX_ENTRIES   = 30;
const MAX_TOTAL     = 40 * 1024 * 1024;
const MAX_ONE       = { image: 12 * 1024 * 1024, video: 25 * 1024 * 1024, audio: 8 * 1024 * 1024 };

const store = new Map();               // messageId -> entry
let totalBytes = 0;

/** message ke wrappers kholta hai; (inner media type, media object, view-once tha ya nahi) lautata hai */
function unwrap(message) {
  let m = message, vo = false;
  for (let i = 0; i < 8 && m; i++) {
    if (m.ephemeralMessage?.message)            { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessageV2Extension?.message)  { vo = true; m = m.viewOnceMessageV2Extension.message; continue; }
    if (m.viewOnceMessageV2?.message)           { vo = true; m = m.viewOnceMessageV2.message; continue; }
    if (m.viewOnceMessage?.message)             { vo = true; m = m.viewOnceMessage.message; continue; }
    if (m.documentWithCaptionMessage?.message)  { m = m.documentWithCaptionMessage.message; continue; }
    break;
  }
  if (!m) return null;
  for (const [key, type] of [['imageMessage', 'image'], ['videoMessage', 'video'], ['audioMessage', 'audio']]) {
    if (m[key]) return { type, media: m[key], viewOnce: vo || m[key].viewOnce === true };
  }
  return null;
}

function drop(id) {
  const e = store.get(id);
  if (e) { totalBytes -= e.size || 0; store.delete(id); }
}

function evict() {
  const now = Date.now();
  for (const [id, e] of store) if (now - e.ts > TTL_MS) drop(id);
  while (store.size > MAX_ENTRIES || totalBytes > MAX_TOTAL) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
}

async function fetchBuffer(media, type) {
  const stream = await downloadContentFromMessage(media, type);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

/** handler me har aane wale message par call hota hai. Fire-and-forget, kabhi throw nahi karta. */
function capture(sock, msg) {
  try {
    const id = msg?.key?.id;
    if (!id || !msg.message || store.has(id)) return;
    const u = unwrap(msg.message);
    if (!u || !u.viewOnce) return;
    const { type, media } = u;
    if (!media.url && !media.directPath) return;                         // is message me media info hi nahi
    const len = Number(media.fileLength?.toString?.() ?? media.fileLength ?? 0);
    if (len && len > MAX_ONE[type]) return;                               // bahut bada — RAM bachao

    const entry = {
      type, ts: Date.now(), size: 0, buffer: null, failed: false,
      caption: media.caption || '', mimetype: media.mimetype || '', ptt: !!media.ptt, seconds: media.seconds || 0,
    };
    entry.promise = fetchBuffer(media, type).then((buf) => {
      if (buf.length > MAX_ONE[type]) { entry.failed = true; drop(id); return entry; }
      entry.buffer = buf; entry.size = buf.length; totalBytes += buf.length; evict();
      return entry;
    }).catch(() => { entry.failed = true; drop(id); return entry; });
    store.set(id, entry);
  } catch (_) { /* cache ki wajah se bot kabhi na ruke */ }
}

/** message-id se saved media (download poora hone tak ruk kar). Na mile to null. */
async function get(id) {
  if (!id) return null;
  const e = store.get(id);
  if (!e) return null;
  await e.promise;
  return e.buffer ? e : null;
}

module.exports = { capture, get, unwrap, _store: store };
