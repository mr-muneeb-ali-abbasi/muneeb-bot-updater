'use strict';
/**
 * Fight Mode — shared multi-step reply helper.
 * fightmood.js aur fightcode.js dono isko use karte hain taaki "agle text
 * reply ka wait karo" wala logic sirf ek jagah likha jaye.
 *
 * Yeh handler.js ko bilkul nahi chhedta — sock.ev par apna temporary
 * listener lagata hai jo sirf us ek chat+sender ke agle text reply ko
 * pakadta hai, kaam hote hi (ya timeout par) khud hat jaata hai.
 */

const STEP_TIMEOUT_MS = 2 * 60 * 1000;
const activeFlows = new Map(); // `${chatId}:${sender}` -> cleanup fn

function flowKey(chatId, sender) { return `${chatId}:${sender}`; }

function waitForReply(sock, chatId, sender, onReply, onTimeout, timeoutMs) {
  const key = flowKey(chatId, sender);
  const prevCleanup = activeFlows.get(key);
  if (prevCleanup) prevCleanup();

  let settled = false;
  const handler = ({ messages }) => {
    if (settled) return;
    for (const m of messages || []) {
      if (!m.message) continue;
      if (m.key.remoteJid !== chatId) continue;
      const mSender = m.key.participant || m.key.remoteJid;
      if (mSender !== sender) continue;
      const text = (m.message.conversation ||
        m.message.extendedTextMessage?.text || '').trim();
      if (!text) continue;
      settled = true;
      cleanup();
      onReply(text, m);
      return;
    }
  };

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    onTimeout();
  }, timeoutMs || STEP_TIMEOUT_MS);

  function cleanup() {
    clearTimeout(timer);
    sock.ev.off('messages.upsert', handler);
    if (activeFlows.get(key) === cleanup) activeFlows.delete(key);
  }

  sock.ev.on('messages.upsert', handler);
  activeFlows.set(key, cleanup);
  return cleanup;
}

module.exports = { waitForReply, STEP_TIMEOUT_MS };
