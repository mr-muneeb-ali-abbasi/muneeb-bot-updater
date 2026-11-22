'use strict';

/**
 * utils/groupStatusRevoke.js — group ke kisi member ka message / GROUP STATUS admin ban kar delete karna.
 *
 * Research (Baileys issue #2903 + WAHA #2350 + saurusagain/delltrak forks), Nov 2026:
 *
 *  1) Ek *published group status* (groupStatusMessageV2) ko WhatsApp ek khaas stanza ke saath bhejta/rakhta hai:
 *     <meta is_group_status="true"/>. Admin ka "delete for everyone" (revoke) bhi isi meta node ke bina
 *     us post par lagta hi nahi — server revoke ko ignore kar deta hai. Baileys ka normal
 *     sock.sendMessage(jid, { delete: key }) wo node nahi lagata, isliye "normal message delete ho jata hai,
 *     group status nahi" — yahi masla tha.
 *  2) Baileys rc.9/rc14 incoming group-status <status> stanza ko drop kar deta hai (sirf ack karta hai). Bot ko
 *     post tab hi dikhta hai jab koi us par REPLY kare (post contextInfo.quotedMessage mein aata hai). Isiliye
 *     delete ka tareeqa "post par reply karke .delete" hai — post ka key (stanzaId + participant) reply se milta hai.
 *  3) Admin revoke ka stanza attribute edit="8" hota hai (sender revoke = "7"). sock.sendMessage ye khud lagata
 *     hai; hum relayMessage se bhej rahe hain, isliye yahan khud lagate hain.
 *
 * Plain message (ya "X ne group ko status mein mention kiya" notice) ke liye purana normal delete bhi saath chalta hai.
 */

const crypto = require('crypto');

const V2_KEY      = /^groupstatusmessage(v\d+)?$/i;                 // published group status
const MENTION_KEY = /^(groupstatusmention|statusmention)message(v\d+)?$/i;   // "mentioned this group in a status" notice

/** quotedMessage ko dekh kar batao: 'v2' (group status post) | 'mention' (mention notice) | null. */
function classify(quoted) {
  let v2 = false, mention = false;
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 5) return;
    for (const k of Object.keys(o)) {
      if (V2_KEY.test(k)) v2 = true;
      else if (MENTION_KEY.test(k)) mention = true;
      else if (k === 'isGroupStatus' && o[k] === true) v2 = true;
      const v = o[k];
      if (v && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Uint8Array)) walk(v, depth + 1);
    }
  };
  walk(quoted, 0);
  return v2 ? 'v2' : mention ? 'mention' : null;
}

function _baileys() { try { return require('@whiskeysockets/baileys'); } catch (_) { return null; } }

function _newId(sock) {
  const b = _baileys();
  try {
    if (b && typeof b.generateMessageIDV2 === 'function') return b.generateMessageIDV2(sock?.user?.id);
    if (b && typeof b.generateMessageID === 'function') return b.generateMessageID();
  } catch (_) {}
  return '3EB0' + crypto.randomBytes(9).toString('hex').toUpperCase();
}

function _revokeType() {
  try { return _baileys().proto.Message.ProtocolMessage.Type.REVOKE; } catch (_) { return 0; }
}

const short = (j) => (j ? String(j).split('@')[0] : '-');

// Server ne revoke qubool kiya ya reject kiya — console mein dikhao (silent failure nahi).
function _traceAck(sock, id, label) {
  const onAck = (node) => {
    try {
      if (node?.attrs?.id !== id) return;
      const err = node.attrs.error;
      console.log(`[GS-REVOKE] ${label}: server ack ${err ? '❌ REJECT error=' + err : '✅ accepted'}`);
    } catch (_) {}
  };
  try { sock.ws?.on?.('CB:ack,class:message', onAck); } catch (_) {}
  const t = setTimeout(() => { try { sock.ws?.off?.('CB:ack,class:message', onAck); } catch (_) {} }, 20000);
  if (t.unref) t.unref();
}

/** Admin revoke, <meta is_group_status="true"/> node ke saath. */
async function revokeGroupStatusPost(sock, groupJid, targetId, participant) {
  const messageId = _newId(sock);
  const key = { remoteJid: groupJid, fromMe: false, id: targetId };
  if (participant) key.participant = participant;
  const message = { protocolMessage: { key, type: _revokeType() } };
  const opts = {
    messageId,
    additionalAttributes: { edit: '8' },                                            // 8 = admin revoke
    additionalNodes: [{ tag: 'meta', attrs: { is_group_status: 'true' }, content: undefined }],
  };
  _traceAck(sock, messageId, `meta-revoke(${short(participant)})`);
  await sock.relayMessage(groupJid, message, opts);
  return messageId;
}

/**
 * Group ke ek message ko delete karo.
 * @param {string[]} forms  sender ke saare JID forms (LID / phone) — jo mile sab
 * @param {object}   opts   { kind: 'v2'|'mention'|null, forceStatus: bool }
 * @returns {{ ok: boolean, steps: string[], lastErr: Error|null }}
 */
async function deleteGroupMessage(sock, groupJid, targetId, forms, opts = {}) {
  const list = [...new Set((forms || []).filter(Boolean))];
  if (!list.length) list.push(undefined);
  const isStatus = opts.forceStatus === true || opts.kind === 'v2';
  const steps = [];
  let metaSent = false, plainOk = false, lastErr = null;

  // 1) group-status post → meta node wala admin revoke (har JID form ke saath)
  if (isStatus) {
    for (const p of list) {
      try {
        await revokeGroupStatusPost(sock, groupJid, targetId, p);
        metaSent = true;
        steps.push(`meta-revoke sent (${short(p)})`);
      } catch (e) {
        lastErr = e;
        steps.push(`meta-revoke FAILED (${short(p)}): ${e.message}`);
      }
    }
  }

  // 2) normal delete — plain message / mention notice ke liye sahi raasta, status ke liye extra bima
  for (const p of list) {
    try {
      const key = { remoteJid: groupJid, id: targetId, fromMe: false };
      if (p) key.participant = p;
      await sock.sendMessage(groupJid, { delete: key });
      plainOk = true;
      steps.push(`plain delete sent (${short(p)})`);
      break;
    } catch (e) {
      lastErr = e;
      steps.push(`plain delete FAILED (${short(p)}): ${e.message}`);
    }
  }

  return { ok: metaSent || plainOk, steps, lastErr };
}

module.exports = { classify, deleteGroupMessage, revokeGroupStatusPost };
