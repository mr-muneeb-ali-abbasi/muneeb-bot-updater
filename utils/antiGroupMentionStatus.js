'use strict';

/**
 * antiGroupMentionStatus — NEW, fully separate from utils/antiGroupMention.js
 *
 * Catches WhatsApp "Group Status" posts and "X mentioned this group in a status"
 * notices that members push into the group, and ALWAYS tries to delete them.
 *
 * Modes (per group, `.antigroupmentionstatus set <mode>`):
 *   warn   (default) delete + warning; after <limit> warnings (default 2) → user removed
 *   delete           delete only (no warning, no removal)
 *   kick             delete + remove immediately
 *
 * Never punished: group admins, bot owners, bot accounts of this panel and
 * posts made by .allgroupstatus.
 *
 * Differences from the old module (why "only warns, never deletes" is fixed):
 *   • delete is ALWAYS attempted (old code skipped it whenever the cached bot-admin flag was false)
 *   • delete is tried with every JID form of the sender (LID / phone) and every result is logged
 *   • warning / removal never depends on the delete having worked
 *   • removal result is checked (status 200) and retried with the other JID form
 *   • detection is broad (regex on key names + protocol type 25, any wrapper depth)
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'antiGroupMentionStatus.json');

// ── detection ────────────────────────────────────────────────────────────────
const KEY_RE = /^(groupstatus(mention)?|statusmention)message(v\d+)?$|^groupmentionedmessage$/i;
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage', 'deviceSentMessage'];
const STATUS_MENTION_PROTO = 25;   // ProtocolMessage.Type.STATUS_MENTION_MESSAGE

function unwrap(msg) {
  const layers = [];
  let m = msg?.message;
  for (let depth = 0; m && typeof m === 'object' && depth < 6; depth++) {
    layers.push(m);
    let next = null;
    for (const w of WRAPPERS) if (m[w]?.message) { next = m[w].message; break; }
    if (!next) break;
    m = next;
  }
  return layers;
}

/** @returns {string|null} what kind of group-status message this is (null = not one) */
function detect(msg) {
  for (const m of unwrap(msg)) {
    for (const k of Object.keys(m)) {
      if (m[k] && KEY_RE.test(k)) return k;
    }
    const pm = m.protocolMessage;
    if (pm && (pm.type === STATUS_MENTION_PROTO || pm.type === 'STATUS_MENTION_MESSAGE')) {
      return 'protocol:STATUS_MENTION_MESSAGE';
    }
  }
  return null;
}

// Log (once per key name) any status/mention-looking message type we do NOT recognise,
// so a new WhatsApp format is visible in the console instead of silently slipping through.
const _unknownLogged = new Set();
const KNOWN_HARMLESS = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);
function noteUnknown(msg) {
  try {
    for (const m of unwrap(msg)) {
      for (const k of Object.keys(m)) {
        if (KNOWN_HARMLESS.has(k) || _unknownLogged.has(k)) continue;
        if (/status|mention/i.test(k) && !KEY_RE.test(k)) {
          _unknownLogged.add(k);
          console.log(`[AntiGMS] ℹ️ status-like message type NOT matched (send this line to the developer if group-status posts slip through): ${k}`);
        }
      }
    }
  } catch (_) {}
}

// ── warning storage ──────────────────────────────────────────────────────────
const digits = (v) => String(v || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; } }
function writeAll(d) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); }
  catch (e) { console.error('[AntiGMS] save failed:', e.message); }
}
function getCount(group, ids) {
  const g = readAll()[group] || {};
  return Math.max(0, ...ids.map(i => g[i] || 0));
}
function setCount(group, ids, n) {
  const all = readAll(); all[group] = all[group] || {};
  for (const i of ids) { if (n > 0) all[group][i] = n; else delete all[group][i]; }
  writeAll(all);
}
function resetGroup(group) { const all = readAll(); delete all[group]; writeAll(all); }
function resetUser(group, ids) { setCount(group, ids, 0); }

// ── helpers ──────────────────────────────────────────────────────────────────
function ownBotAccounts() {
  const out = new Set();
  try {
    const sm = require('../panel/sessionManager');
    for (const s of sm.sessions.values()) {
      const u = s?.sock?.user;
      for (const v of [u?.id, u?.lid]) { const d = digits(v); if (d) out.add(d); }
    }
  } catch (_) {}
  return out;
}

/** Every JID form we know for the sender (LID first, then phone), de-duplicated. */
function senderJids(msg) {
  const k = msg.key || {};
  return [...new Set([k.participant, k.participantPn, k.participantAlt, k.senderPn].filter(Boolean))];
}

/** Delete the post. Tries each sender-JID form until one request goes through. */
async function deletePost(sock, msg, from) {
  const forms = senderJids(msg);
  if (!forms.length) forms.push(undefined);
  let lastErr = null;
  for (const p of forms) {
    try {
      const key = { remoteJid: from, id: msg.key.id, fromMe: false };
      if (p) key.participant = p;
      await sock.sendMessage(from, { delete: key });
      console.log(`[AntiGMS] 🗑️ delete request sent (participant=${p ? String(p).split('@')[0] : '-'})`);
      return true;
    } catch (e) {
      lastErr = e;
      console.log(`[AntiGMS] delete failed with participant=${p ? String(p).split('@')[0] : '-'}: ${e.message}`);
    }
  }
  console.log(`[AntiGMS] ❌ could not delete the post (${lastErr ? lastErr.message : 'unknown'}) — is the bot admin?`);
  return false;
}

/** Remove the user. Checks WhatsApp's per-user status code, retries the other JID form. */
async function removeUser(sock, msg, from) {
  for (const p of senderJids(msg)) {
    try {
      const res = await sock.groupParticipantsUpdate(from, [p], 'remove');
      const st  = String(res?.[0]?.status ?? '200');
      if (st === '200') return true;
      console.log(`[AntiGMS] remove ${String(p).split('@')[0]} → status ${st}`);
    } catch (e) {
      console.log(`[AntiGMS] remove failed (${String(p).split('@')[0]}): ${e.message}`);
    }
  }
  return false;
}

const FOOT = '> Powered by 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭';
const COOLDOWN_MS = 20_000;
const _recent  = new Map();   // `${group}:${user}` → ts   (one post can arrive as 2 events → count once)
const _seenMsg = new Map();   // msgId → ts
const tag = (jid) => `@${digits(jid)}`;

/**
 * @param {object} ctx { senderIsAdmin, senderIsOwner, botIsAdmin, mode, limit, recheckBotAdmin }
 * @returns {Promise<boolean>} true = message was a group-status post and has been handled
 */
async function enforce(sock, msg, ctx) {
  const kind = detect(msg);
  if (!kind) return false;

  const from = msg.key.remoteJid;
  const participant = msg.key.participant || msg.key.participantPn || null;
  if (!from?.endsWith('@g.us') || !participant) return false;
  if (msg.key.fromMe) return false;

  const now = Date.now();
  if (_seenMsg.has(msg.key.id)) return true;
  _seenMsg.set(msg.key.id, now);
  if (_seenMsg.size > 500) for (const [k, t] of _seenMsg) if (now - t > 120_000) _seenMsg.delete(k);

  const ids = [...new Set(senderJids(msg).map(digits).filter(Boolean))];

  if (ctx.senderIsOwner || ctx.senderIsAdmin) {
    console.log(`[AntiGMS] ${kind} by exempt (admin/owner) ${ids[0]} — ignored`);
    return true;
  }
  if (global.__agsIds && global.__agsIds.has(msg.key.id)) {
    console.log(`[AntiGMS] ${kind} posted by .allgroupstatus — ignored`);
    return true;
  }
  const own = ownBotAccounts();
  if (ids.some(i => own.has(i))) {
    console.log(`[AntiGMS] ${kind} by one of our own bot accounts — ignored`);
    return true;
  }

  const mode  = ['warn', 'delete', 'kick'].includes(ctx.mode) ? ctx.mode : 'warn';
  const limit = Math.min(10, Math.max(1, parseInt(ctx.limit, 10) || 2));
  console.log(`[AntiGMS] ${kind} by ${ids[0]} in ${from.split('@')[0]} (mode=${mode}, limit=${limit}, botAdmin=${ctx.botIsAdmin})`);

  // 1) delete — ALWAYS attempted, whatever the cached admin flag says
  const deleted = await deletePost(sock, msg, from);

  // bot not admin? one live re-check (cached "false" may be stale) — used only for wording / removal
  let botIsAdmin = !!ctx.botIsAdmin;
  if (!botIsAdmin && typeof ctx.recheckBotAdmin === 'function') {
    try { botIsAdmin = !!(await ctx.recheckBotAdmin()); } catch (_) {}
  }
  const adminNote = botIsAdmin ? '' : `\n\n⚠️ I am *not an admin* here, so I may not be able to delete messages or remove members — please make me admin.`;

  if (mode === 'delete') return true;

  // same user, same moment → already counted
  const rk = `${from}:${ids[0]}`;
  if (_recent.has(rk) && now - _recent.get(rk) < COOLDOWN_MS) return true;
  _recent.set(rk, now);
  if (_recent.size > 500) for (const [k, t] of _recent) if (now - t > 120_000) _recent.delete(k);

  const count = getCount(from, ids) + 1;
  const kick  = mode === 'kick' || count >= limit;

  if (!kick) {
    setCount(from, ids, count);
    await sock.sendMessage(from, {
      text:
        `⚠️ *GROUP STATUS WARNING*\n\n` +
        `${tag(participant)}, posting a *group status* (or mentioning this group in a status) is *NOT allowed* in this group.\n\n` +
        (deleted
          ? `🗑️ Your message was deleted.\n`
          : `⚠️ Message delete nahi ho saka (bot admin check karo) — console mein [AntiGMS] delete failed line dekho.\n`) +
        `📌 Warning *${count}/${limit}* — at ${limit}/${limit} you will be *removed* from the group.` +
        `${adminNote}\n\n${FOOT}`,
      mentions: [participant],
    }).catch((e) => console.log(`[AntiGMS] warning message failed: ${e.message}`));
    return true;
  }

  const removed = await removeUser(sock, msg, from);
  setCount(from, ids, 0);
  await sock.sendMessage(from, {
    text: removed
      ? `🚫 *USER REMOVED*\n\n${tag(participant)} was removed from the group.\n\n📌 Reason: ${mode === 'kick' ? 'posted a group status' : `posted a group status and reached ${limit}/${limit} warnings`}.\n> Group status posting is *not allowed* here.\n\n${FOOT}`
      : `🚫 *FINAL WARNING*\n\n${tag(participant)} posted a group status again.\n> Group status posting is *not allowed* here.\n⚠️ I could not remove this member — I need *admin rights*, please make me admin.\n\n${FOOT}`,
    mentions: [participant],
  }).catch((e) => console.log(`[AntiGMS] notice failed: ${e.message}`));
  return true;
}

module.exports = { detect, noteUnknown, enforce, resetGroup, resetUser, getCount };
