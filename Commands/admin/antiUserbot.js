'use strict';
/**
 * utils/antiUserbot.js — doosre WhatsApp bots / automated accounts ko group se nikalta hai.
 *
 *  Ultra-Strict version — naye hard signals:
 *    • Interactive/button/list message type         → INSTANT remove (sirf bot frameworks bhejte hain)
 *    • "@bot" type WhatsApp JID                      → INSTANT remove (official bot-category account)
 *    • Pehle kabhi flag ho chuka number (koi bhi group) → INSTANT remove, dobara mauka nahi
 *  Soft signals (flood/repeat/mentions/URL/foreign-prefix/JID-pattern) accumulate ho kar ek
 *  conservative threshold par remove karte hain — taaki koi bhi NORMAL insaan (chahe active ho,
 *  thoda flood kare, ya kabhi-kabhi link bheje) kabhi galti se na pakड़ा jaaye.
 *
 *  Hamesha exempt: group admin, bot ka apna owner/connected-owner, aur user ke apne doosre
 *  panel-bots (isOurBot — taaki ek bot doosre ko na nikaale).
 */
const fs = require('fs');
const path = require('path');

const FLAG_FILE = path.join(__dirname, '../data/antiUserbotFlags.json');
const ANTIUSERBOT_VIDEO_PATH = path.join(__dirname, '../data/antiuserbot-alert.mp4');

/* ─────────────────── persistent "already flagged" memory ─────────────────── */
function loadFlags() { try { return JSON.parse(fs.readFileSync(FLAG_FILE, 'utf8')); } catch (_) { return {}; } }
function saveFlags(d) { try { fs.mkdirSync(path.dirname(FLAG_FILE), { recursive: true }); fs.writeFileSync(FLAG_FILE, JSON.stringify(d, null, 1)); } catch (_) {} }
function num(j) { return String(j || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, ''); }
function flagBot(jid, reason) { const d = loadFlags(); d[num(jid)] = { t: Date.now(), reason }; saveFlags(d); }
function isFlagged(jid) { const d = loadFlags(); return !!d[num(jid)]; }
function clearFlag(jid) { const d = loadFlags(); if (d[num(jid)]) { delete d[num(jid)]; saveFlags(d); return true; } return false; }

/* ─────────────────── in-memory soft-signal tracking ─────────────────── */
const groupTracker = new Map(); // groupJid -> Map(userJid -> {msgTimestamps, lastMsgs, score})
const FLOOD_WINDOW_MS = 4000;
const FLOOD_LIMIT = 5;    // 5 msgs / 4 sec
const REPEAT_LIMIT = 4;   // 4x hu-ba-hu same message
const MENTION_LIMIT = 10; // 10+ mentions ek saath
const URL_LIMIT = 4;      // 4+ links ek message mein
const SCORE_THRESHOLD = 3;
const TRACKER_TTL_MS = 60000;
const SCORES = { FOREIGN_PREFIX: 2, MENTION_SPAM: 1, URL_FLOOD: 1, FLOOD: 2, REPEAT: 2, JID_PATTERN: 1 };

const FOREIGN_PREFIX_REGEX = /^[!\/#%^&~|\\]/;
const URL_REGEX = /https?:\/\/[^\s]+/gi;

function isSuspiciousJid(jid) {
  const n = jid.split('@')[0];
  if (!n || n.length < 10) return false;
  if (/^(\d)\1{9,}$/.test(n)) return true;                                   // 00000000000 jaisa
  if (/^(01234|12345|23456|34567|45678|56789|98765|87654)/.test(n)) return true; // sequential
  if (n.length > 15) return true;                                             // real phone kabhi itna lamba nahi
  return false;
}
function getTracker(groupJid, userJid) {
  if (!groupTracker.has(groupJid)) groupTracker.set(groupJid, new Map());
  const g = groupTracker.get(groupJid);
  if (!g.has(userJid)) g.set(userJid, { msgTimestamps: [], lastMsgs: [], score: 0 });
  return g.get(userJid);
}
function cleanTracker(t) { const now = Date.now(); t.msgTimestamps = t.msgTimestamps.filter((x) => now - x < TRACKER_TTL_MS); }

/* ─────────────────── remove + alert ─────────────────── */
async function removeBot(sock, from, botJid, msg, reason) {
  flagBot(botJid, reason);
  try { await sock.groupParticipantsUpdate(from, [botJid], 'remove'); } catch (e) { console.error('[AntiUserbot Remove]', e?.message || e); }
  const number = num(botJid);
  const alertText =
    `*[ 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 ]*\n\n` +
    `🚫 *Bot / Automated Account Removed!*\n\n` +
    `👤 Number: @${number}\n` +
    `📋 Reason: ${reason}\n\n` +
    `🛡️ _Ultra-Strict Anti-UserBot Protection Active_\n` +
    `> Powered by 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭`;
  try {
    if (fs.existsSync(ANTIUSERBOT_VIDEO_PATH)) {
      await sock.sendMessage(from, {
        video: fs.readFileSync(ANTIUSERBOT_VIDEO_PATH), mimetype: 'video/mp4',
        fileName: 'antiuserbot-alert.mp4', caption: alertText, mentions: [botJid],
      });
    } else {
      await sock.sendMessage(from, { text: alertText, mentions: [botJid] });
    }
  } catch (_) {}
  return true;
}

/* ─────────────────── main entry — handler.js calls this ───────────────────
   opts: { from, sender, senderIsAdmin, senderIsOwner, botIsAdmin } */
async function inspect(sock, msg, opts) {
  try {
    const { from, sender, senderIsAdmin, senderIsOwner } = opts || {};
    if (!from?.endsWith('@g.us') || !sender) return false;
    if (senderIsOwner || senderIsAdmin) return false;
    try { if (require('./respectGuard').isOurBot(sender, msg)) return false; } catch (_) {}

    // ── pehle se flagged number — dobara koi scoring nahi, seedha bahar ──
    if (isFlagged(sender)) {
      return await removeBot(sock, from, sender, msg, '🔁 Pehle bhi bot/automated account ki tarah flag ho chuka hai');
    }

    const msgBody = (
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption || ''
    ).trim();

    // ── INSTANT: interactive/button/list message — sirf bot framework bhejte hain ──
    const msgType = Object.keys(msg.message || {})[0];
    if (['buttonsMessage', 'templateMessage', 'listMessage', 'interactiveMessage', 'buttonsResponseMessage', 'listResponseMessage'].includes(msgType)) {
      return await removeBot(sock, from, sender, msg, '🤖 Interactive/button message — bot ka pakka signature');
    }

    // ── INSTANT: "@bot"-type WhatsApp JID (official bot-category account) ──
    if (String(sender).endsWith('@bot')) {
      return await removeBot(sock, from, sender, msg, '🤖 WhatsApp Bot-category account (@bot JID)');
    }

    // ── soft signals (accumulate, conservative threshold) ──
    const tracker = getTracker(from, sender);
    cleanTracker(tracker);
    let score = 0; const reasons = [];

    if (isSuspiciousJid(sender)) { score += SCORES.JID_PATTERN; reasons.push('Suspicious JID pattern'); }

    if (msgBody && FOREIGN_PREFIX_REGEX.test(msgBody) && /^.[a-zA-Z]/.test(msgBody) && msgBody.length <= 40 && !msgBody.startsWith('.')) {
      score += SCORES.FOREIGN_PREFIX; reasons.push(`Foreign bot-prefix command: "${msgBody.slice(0, 15)}"`);
    }

    const mentionCount = (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).length;
    if (mentionCount >= MENTION_LIMIT) { score += SCORES.MENTION_SPAM; reasons.push(`Mass mention: ${mentionCount}`); }

    const urlMatches = msgBody.match(URL_REGEX) || [];
    if (urlMatches.length >= URL_LIMIT) { score += SCORES.URL_FLOOD; reasons.push(`URL flood: ${urlMatches.length}`); }

    const now = Date.now();
    tracker.msgTimestamps.push(now);
    const recent = tracker.msgTimestamps.filter((t) => now - t < FLOOD_WINDOW_MS);
    if (recent.length >= FLOOD_LIMIT) { score += SCORES.FLOOD; reasons.push(`Flood: ${recent.length} msgs/4s`); }

    if (msgBody) {
      tracker.lastMsgs.push(msgBody);
      if (tracker.lastMsgs.length > 10) tracker.lastMsgs.shift();
      const rep = tracker.lastMsgs.filter((m) => m === msgBody).length;
      if (rep >= REPEAT_LIMIT) { score += SCORES.REPEAT; reasons.push(`Repeat: ${rep}x same message`); tracker.lastMsgs = []; }
    }

    tracker.score += score;
    if (tracker.score >= SCORE_THRESHOLD) {
      tracker.score = 0;
      return await removeBot(sock, from, sender, msg, reasons.join(' | ') || 'Automated behaviour pattern');
    }
    return false;
  } catch (e) {
    console.error('[AntiUserbot]', e?.message || e);
    return false;
  }
}

module.exports = { inspect, isFlagged, flagBot, clearFlag };
