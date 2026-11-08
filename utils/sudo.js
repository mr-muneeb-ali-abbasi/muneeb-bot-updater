'use strict';
/**
 * utils/sudo.js — ek jagah se sudo list manage karta hai.
 *
 * Sudo list HAR BOT SESSION ki ALAG hoti hai (database.getBotSetting /
 * updateBotSettings ke through, jaisa .setprefix apna prefix save karta hai) —
 * matlab Server 1 ke bot par kisi ko sudo banaya to woh sirf usi bot/number
 * par sudo hai, dusre connected numbers par nahi.
 *
 * Sudo ka matlab: selfMode (private mode) mein bhi bot use kar sakta hai,
 * mod-only commands chala sakta hai — jaisa owner. LEKIN *ownerOnly* aur
 * *superAdminOnly* wale commands (jaise .broadcast, .restart, .addsudo khud,
 * .wishcode) sudo kabhi bypass nahi karta — sirf asli owner/developer ke
 * liye hi rehte hain.
 */
const database = require('../database');

function digits(v) {
  return String(v || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function getSudoList(botId) {
  const raw = database.getBotSetting(botId, 'sudoList', []);
  return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
}

function isSudo(botId, sender) {
  const num = digits(sender);
  if (!num || !botId) return false;
  return getSudoList(botId).includes(num);
}

function addSudo(botId, numberOrJid) {
  const num = digits(numberOrJid);
  if (!num) return false;
  const list = getSudoList(botId);
  if (!list.includes(num)) {
    list.push(num);
    database.updateBotSettings(botId, { sudoList: list });
  }
  return true;
}

function removeSudo(botId, numberOrJid) {
  const num = digits(numberOrJid);
  const before = getSudoList(botId);
  const list = before.filter((n) => n !== num);
  if (list.length !== before.length) {
    database.updateBotSettings(botId, { sudoList: list });
    return true;
  }
  return false;
}

module.exports = { digits, getSudoList, isSudo, addSudo, removeSudo };
