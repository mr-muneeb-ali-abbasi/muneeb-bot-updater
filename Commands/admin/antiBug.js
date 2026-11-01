'use strict';
/**
 * utils/antiBug.js — Crash/Virus/Bug-tool attack guard.
 *
 *  Kis cheez se bachata hai: ".crash-oom <number> <amount>", "bug-send", "virus-send" jaise
 *  WhatsApp-crash/attack-tool commands, aur unka "ATTACKING SUCCESS / TARGET / VIRUS" wala
 *  confirmation reply (dusre bots jaise "dark.shadow" jo group mein hi chal rahe hote hain) —
 *  plus raw malformed/oversized payloads (mention-bomb, zalgo-bomb, giant text, contact-bomb)
 *  jo WhatsApp client ko crash/freeze karne ke liye bheje jaate hain.
 *
 *  ⚠️ Sab checks JAAN-BOOJH KAR extreme/rare patterns par based hain — koi bhi normal insaan
 *  ki roz-marra ki baat-cheet (gaali, flood, lambi message, mention 5-10) is se touch NAHI hoti.
 *  Sirf asli attack-tool commands/payloads hi pakड़े jaate hain.
 *
 *  Group: toggle-able (.antibug on/off), sirf group-leader bot action leta hai.
 *  Personal/DM: hamesha ON — koi bhi bot ko seedha crash/bug bhejega to automatic block ho jayega.
 *
 *  Action: message delete → (group ho aur bot admin ho to) group se remove → permanent block.
 */
const fs = require('fs');
const path = require('path');
const database = require('../database');

const FILE = path.join(__dirname, '../data/antiBug.json');

function num(j) { return String(j || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, ''); }

function loadDb() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; } }
function saveDb(d) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 1)); } catch (_) {} }

function recordOffender(sender, reason) {
  const d = loadDb(); d.offenders = d.offenders || {};
  const n = num(sender);
  const prev = d.offenders[n];
  d.offenders[n] = { t: Date.now(), reason, count: (prev ? prev.count : 0) + 1 };
  saveDb(d);
}
function isKnownOffender(sender) {
  const d = loadDb();
  return !!(d.offenders && d.offenders[num(sender)]);
}
function status() {
  const d = loadDb();
  return { count: Object.keys(d.offenders || {}).length, offenders: d.offenders || {} };
}

/* ───────── 1) Known crash/bug/virus attack-tool COMMAND signatures ─────────
   e.g. ".crash-oom 923219861713 250", "bug-send 923xxxxxxxxx 500", ".xcrash ..."
   Joda-hua (no-space) keyword + ek phone-number-jaisa argument (10-15 digit) — ye combo
   normal chat mein kabhi nahi aata, isliye 100% safe hai. */
const PHONE_ARG_RE = /\b\d{10,15}\b/;
const CRASH_CMD_KEYWORDS = [
  'crash-oom', 'crashoom', 'oom-crash', 'oomcrash', 'crash-bug', 'crashbug', 'bug-crash', 'bugcrash',
  'force-crash', 'forcecrash', 'auto-crash', 'autocrash', 'delay-crash', 'delaycrash', 'xcrash', 'x-crash',
  'ghost-bug', 'ghostbug', 'invisible-bug', 'invisiblebug', 'freeze-bug', 'freezebug', 'hang-bug', 'hangbug',
  'virus-send', 'virussend', 'send-virus', 'sendvirus', 'crash-virus', 'crashvirus', 'bug-send', 'bugsend',
  'crash-send', 'crashsend', 'phone-crash', 'phonecrash', 'wa-crash', 'wacrash', 'whatsapp-crash', 'whatsappcrash',
  'crashbomb', 'bombvirus', 'wakill', 'killwa', 'deadbot-send', 'hang-send', 'freeze-send',
];
function looksLikeCrashCommand(text) {
  if (!text) return false;
  if (!PHONE_ARG_RE.test(text)) return false;
  const low = text.toLowerCase();
  return CRASH_CMD_KEYWORDS.some((k) => low.includes(k));
}

/* ───────── 2) Attack-tool RESPONSE signature (jaise "dark.shadow" bot ka reply) ─────────
   「 ATTACKING SUCCESS 」 / TARGET : / VIRUS : / AMOUNT : — in mein se kam az kam 2 ek saath
   milein tabhi trigger ho, taaki koi akela lafz galti se match na kare. */
const RESPONSE_MARKERS = [
  /ATTACKING\s+SUCCESS/i, /ATTACK\s+SUCCESS/i, /\bTARGET\s*:/i, /\bVIRUS\s*:/i,
  /\bAMOUNT\s*:\s*\d/i, /\bHIT\s*:\s*\d/i, /PAYLOAD\s+SENT/i, /CRASH\s+SENT/i, /BUG\s+SENT/i,
];
function looksLikeAttackResponse(text) {
  if (!text) return false;
  let hits = 0;
  for (const r of RESPONSE_MARKERS) if (r.test(text)) hits++;
  return hits >= 2;
}

/* ───────── 3) Raw malformed/oversized PAYLOAD outliers (extreme thresholds only) ─────────
   ⚠️ Bahut saare bots (jaise "readmore" trick wale menus) decorative purposes ke liye
   U+200E/U+200F (LRM/RLM — invisible spacer) hazaaron baar use karte hain — ye NORMAL hai,
   isliye in dono ko bidi-bomb check se bahar rakha hai. Sirf genuinely dangerous
   direction-OVERRIDE characters (RLO/LRO/PDF/isolates) count hote hain, aur woh bhi bahut
   high threshold par. */
const ZALGO_RE = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿]/g;
const BIDI_RE = /[‪-‮⁦-⁩]/g;   // LRM/RLM (‎/‏) jaan-boojh kar exclude
const countMatches = (re, s) => { const m = s.match(re); return m ? m.length : 0; };

// bana-sajaya box-drawn menu/banner block — real crash-payload kabhi aise format mein nahi aata
const looksLikeDecorativeMenu = (text) =>
  !!text && /^\s*[╔┏╭┌▄█🌟👑✨⚡🔥╭]/u.test(text) && text.split('\n').length > 6;

function rawPayloadOutliers(msg, text) {
  const reasons = [];
  if (looksLikeDecorativeMenu(text)) return reasons;   // menu/banner — kabhi outlier-scan mat karo

  const ctx = msg.message?.extendedTextMessage?.contextInfo
    || msg.message?.imageMessage?.contextInfo
    || msg.message?.videoMessage?.contextInfo
    || {};
  const mentions = ctx.mentionedJid || [];
  if (mentions.length >= 400) reasons.push(`Mention-bomb: ${mentions.length} mentions ek message mein`);

  if (text) {
    if (text.length >= 15000) reasons.push(`Oversized payload: ${text.length} characters`);
    let longest = 0;
    for (const w of text.split(/\s+/)) if (w.length > longest) longest = w.length;
    if (longest >= 6000) reasons.push(`Single unbroken block: ${longest} chars (render-crash pattern)`);
    const z = countMatches(ZALGO_RE, text);
    if (z >= 300) reasons.push(`Zalgo bomb: ${z} stacked combining marks`);
    const b = countMatches(BIDI_RE, text);
    if (b >= 300) reasons.push(`Bidi/RTL direction-override bomb: ${b} override chars`);
  }

  const vcard = msg.message?.contactMessage?.vcard || '';
  if (vcard.length >= 8000) reasons.push(`Malformed oversized contact-card: ${vcard.length} chars`);
  const vcards = msg.message?.contactsArrayMessage?.contacts || [];
  if (vcards.length >= 150) reasons.push(`Contact-array bomb: ${vcards.length} contacts ek message mein`);

  return reasons;
}

function extractQuickText(msg) {
  const c = msg.message || {};
  const rc = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message || c;
  return (rc.conversation || rc.extendedTextMessage?.text || rc.imageMessage?.caption || rc.videoMessage?.caption || '').trim();
}

/* ───────── action: delete → (group+admin) remove → permanent block ───────── */
async function punish(sock, msg, opts, reason) {
  const { from, sender, isGroup, botIsAdmin, isLeader } = opts;
  try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}

  let kicked = false;
  if (isGroup && botIsAdmin && isLeader) {
    try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); kicked = true; } catch (_) {}
  }
  let blocked = false;
  try { await sock.updateBlockStatus(sender, 'block'); blocked = true; } catch (_) {}

  recordOffender(sender, reason);
  const who = num(sender);
  const alertText =
    `*[ 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 ]*\n\n` +
    `🛑 *𝐀𝐍𝐓𝐈-𝐁𝐔𝐆 𝐆𝐔𝐀𝐑𝐃*\n\n` +
    `🧨 Crash/Bug/Virus-tool activity detect hui!\n` +
    `👤 Number: @${who}\n` +
    `📋 Wajah: ${reason}\n` +
    (kicked ? `🚪 Group se remove kar diya.\n` : '') +
    (blocked ? `🚫 Permanently block kar diya.\n` : '') +
    `\n🛡️ _Anti-Bug Guard active — Mr.Muneeb Ali Bot_`;
  try {
    if (isGroup) await sock.sendMessage(from, { text: alertText, mentions: [sender] });
  } catch (_) {}
  return true;
}

/* ───────── main entry — handler.js se call hota hai, DM + group dono par ───────── */
async function inspect(sock, msg, opts) {
  try {
    const { from, sender, isGroup } = opts || {};
    if (!sender || !from) return false;
    if (opts.senderIsOwner) return false;
    try { if (require('./respectGuard').isOurBot(sender, msg)) return false; } catch (_) {}

    if (isGroup) {
      const gs = database.getGroupSettings(from);
      if (!gs.antibug) return false;       // group mein feature on honi chahiye
      if (!opts.isLeader) return false;    // sirf ek (leader) bot action le, duplicate na ho
    }
    // DM: hamesha active — apna bot/number bachane ke liye (koi toggle nahi, zaroori hai)

    const text = extractQuickText(msg);

    if (looksLikeCrashCommand(text)) {
      return await punish(sock, msg, opts, `Crash/Bug/Virus-tool command bheja: "${text.slice(0, 60)}"`);
    }
    if (looksLikeAttackResponse(text)) {
      return await punish(sock, msg, opts, 'Attack-tool ka "ATTACKING SUCCESS / TARGET / VIRUS" confirmation reply bheja');
    }
    // Outlier/heuristic payload-scan (mention-bomb, zalgo, bidi-override, oversized) sirf
    // normal members par — group admin bharosemand hota hai, galti se uska koi bana-sajaya
    // ya test-bot menu "bug" na ban jaaye isliye use is layer se chhod diya jaata hai.
    // (Crash-command aur attack-response signature wale upar wale checks admin par bhi chalte hain.)
    if (opts.senderIsAdmin) return false;
    const outliers = rawPayloadOutliers(msg, text);
    if (outliers.length) {
      return await punish(sock, msg, opts, outliers.join(' | '));
    }
    return false;
  } catch (e) {
    console.error('[AntiBug]', e?.message || e);
    return false;
  }
}

module.exports = { inspect, isKnownOffender, recordOffender, status };
