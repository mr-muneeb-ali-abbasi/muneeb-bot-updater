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
const seen  = new Map();               // messageId -> { state, note, keys, ts }  (diagnosis ke liye, sirf chhota record)
const MAX_SEEN = 200;
let totalBytes = 0;

// ── Decrypt-retry gap fix ─────────────────────────────────────────────────
// WhatsApp/Baileys kabhi media (khaaskar view-once) ko turant decrypt nahi kar
// paata — pehle ek khaali "placeholder" message.upsert aata hai, aur asli
// decrypted content BAAD mein ek ALAG event "messages.update" se aata hai
// (upsert se nahi). handler.js sirf upsert sunta hai, isliye aise messages
// kabhi capture() tak pahunchte hi nahi the, aur .vv hamesha "bot ne dekha hi
// nahi" bolta reh jaata tha. Fix: capture() ko jo bhi `sock` milta hai, usi
// par ek baar (per-sock) messages.update bhi sun lo — jab retry ke baad asli
// content aaye, usi capture() logic se guzaar do.
const _watchedSocks = new WeakSet();
function ensureUpdateListener(sock) {
  try {
    if (!sock?.ev || typeof sock.ev.on !== 'function' || _watchedSocks.has(sock)) return;
    _watchedSocks.add(sock);
    sock.ev.on('messages.update', (updates) => {
      try {
        for (const u of updates || []) {
          const id = u?.key?.id;
          const content = u?.update?.message;
          // sirf tab interesting jab is id ko pehle se seen/store nahi kiya,
          // aur update ab asli message-content laaya hai (sirf status/receipt nahi)
          if (!id || !content || store.has(id) || seen.has(id)) continue;
          capture(sock, { key: u.key, message: content });
        }
      } catch (e) { try { console.log('[VO] update-listener error:', e.message); } catch (_) {} }
    });
  } catch (_) {}
}

function markSeen(id, state, note, keys) {
  seen.set(id, { state, note: note || '', keys: keys || '', ts: Date.now() });
  while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
  console.log(`[VO] ${id} → ${state}${note ? ' (' + note + ')' : ''}${keys ? ' | ' + keys : ''}`);
}

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

// ── Active recovery: WhatsApp se seedha "re-upload/refresh" maango ───────────
// Agar pehli baar mein media ka url/directPath nahi mila, Baileys ka apna
// sock.updateMediaMessage(msg) call isi situation ke liye bana hai — yeh
// WhatsApp ko batata hai "iska fresh media bhejo", aur updated keys ke saath
// naya message object deta hai. (downloadMediaMessage() ke andar bhi yahi
// `reuploadRequest` option isi kaam ke liye use hota hai.) Ek message ke liye
// sirf EK baar try karte hain (reupoladTried se), taaki loop na bane.
const reuploadTried = new Set();
async function tryReupload(sock, msg) {
  if (!sock || typeof sock.updateMediaMessage !== 'function') return null;
  const id = msg?.key?.id;
  if (!id || reuploadTried.has(id)) return null;
  reuploadTried.add(id);
  while (reuploadTried.size > MAX_SEEN) reuploadTried.delete(reuploadTried.values().next().value);
  try { return await sock.updateMediaMessage(msg); }
  catch (e) { console.log(`[VO] ${id} → reupload request failed: ${e.message}`); return null; }
}

/** handler me har aane wale message par call hota hai. Fire-and-forget, kabhi throw nahi karta. */
function capture(sock, msg) {
  try {
    ensureUpdateListener(sock);
    const id = msg?.key?.id;
    if (!id || !msg.message || store.has(id) || seen.has(id)) return;
    const u = unwrap(msg.message);
    if (!u) return;                      // text ya kuch aur — ispe diagnostic ki zaroorat nahi
    if (!u.viewOnce) { markSeen(id, 'SEEN_NOT_VO', u.type, 'msgKeys=' + Object.keys(msg.message).join(',')); return; }
    const { type, media } = u;
    const has  = ['url', 'directPath', 'mediaKey'].filter((k) => media[k]).join('+') || 'nothing';
    const keys = 'msgKeys=' + Object.keys(msg.message).join(',') + ' mediaHas=' + has;
    if (!media.url && !media.directPath) {
      markSeen(id, 'NOMEDIA_RETRYING', 'WhatsApp se re-upload maang raha hoon', keys);
      tryReupload(sock, msg).then((updated) => {
        const newMsg = updated?.message ? updated : (updated ? { key: msg.key, message: updated } : null);
        const u2 = newMsg && unwrap(newMsg.message);
        if (!u2 || (!u2.media.url && !u2.media.directPath)) {
          markSeen(id, 'NOMEDIA', 'reupload ke baad bhi WhatsApp ne link nahi diya', keys);
          return;
        }
        seen.delete(id);   // taaki capture() dubara ignore na kare
        capture(sock, { key: msg.key, message: newMsg.message });
      }).catch(() => { markSeen(id, 'NOMEDIA', 'reupload call error', keys); });
      return;
    }
    const len = Number(media.fileLength?.toString?.() ?? media.fileLength ?? 0);
    if (len && len > MAX_ONE[type]) { markSeen(id, 'TOOBIG', Math.round(len / 1048576) + 'MB', keys); return; }

    const entry = {
      type, ts: Date.now(), size: 0, buffer: null, failed: false,
      caption: media.caption || '', mimetype: media.mimetype || '', ptt: !!media.ptt, seconds: media.seconds || 0,
    };
    markSeen(id, 'DOWNLOADING', type, keys);
    entry.promise = fetchBuffer(media, type).then((buf) => {
      if (buf.length > MAX_ONE[type]) { entry.failed = true; drop(id); markSeen(id, 'TOOBIG', 'download ke baad', ''); return entry; }
      entry.buffer = buf; entry.size = buf.length; totalBytes += buf.length; evict();
      markSeen(id, 'STORED', Math.round(buf.length / 1024) + 'KB', '');
      return entry;
    }).catch(async (e) => {
      // link mil gaya tha lekin download fail hua (shayad expire ho gaya) —
      // ek dafa WhatsApp se fresh re-upload maang kar dobara try karo.
      drop(id);
      const updated = await tryReupload(sock, msg).catch(() => null);
      const newMsg = updated?.message ? updated : (updated ? { key: msg.key, message: updated } : null);
      const u2 = newMsg && unwrap(newMsg.message);
      if (u2 && (u2.media.url || u2.media.directPath)) {
        seen.delete(id);
        capture(sock, { key: msg.key, message: newMsg.message });
        return entry;
      }
      entry.failed = true;
      markSeen(id, 'DLFAIL', String(e?.message || e).slice(0, 80), '');
      return entry;
    });
    store.set(id, entry);
  } catch (e) { try { console.log('[VO] capture error:', e.message); } catch (_) {} }
}

/** message-id se saved media (download poora hone tak ruk kar). Na mile to null. */
async function get(id) {
  if (!id) return null;
  const e = store.get(id);
  if (!e) return null;
  await e.promise;
  return e.buffer ? e : null;
}

/** Diagnosis: is message-id ke saath capture me kya hua? {state, note} ya null (bot ne dekha hi nahi) */
function status(id) { return seen.get(id) || null; }

module.exports = { capture, get, status, unwrap, ensureUpdateListener, _store: store, _seen: seen };
