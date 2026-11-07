'use strict';
/**
 * .wishcode — SUPER OWNER ONLY (Main Developer) — Wish Mode access code change.
 * Flow: current code maango → verify → new code maango → confirm maango → save.
 * Code kabhi bhi kisi message/log mein print nahi hota.
 *
 * (Backend storage file ka naam jaan-bujh kar nahi badla — utils/fightmoodAuth.js
 * — taaki pehle se set kiya hua code waisa hi kaam kare.)
 */

const auth = require('../../utils/fightmoodAuth');
const { waitForReply } = require('../../utils/fightmoodFlow');

module.exports = {
  name: 'wishcode',
  category: 'owner',
  description: 'Change the Wish Mode access code (super owner only)',
  usage: '.wishcode',
  superAdminOnly: true,

  async execute(sock, msg, args, extra) {
    const reply = extra && typeof extra.reply === 'function'
      ? extra.reply
      : (t) => sock.sendMessage(msg.key.remoteJid, { text: t }, { quoted: msg });

    const chatId = (extra && extra.from) || msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;

    const hadCode = auth.hasCode();
    await reply(
      hadCode
        ? '🔑 Wish Mode access code change karne ja rahe ho.\n\nPehle *current access code* reply karo:'
        : '🔑 Wish Mode ke liye abhi tak koi access code set nahi hai.\n\nSeedha *naya access code* reply karo (koi current code verify karne ki zaroorat nahi):'
    );

    const askNew = () => {
      reply('✏️ Ab *naya access code* reply karo:');
      waitForReply(sock, chatId, sender, (newCode) => {
        if (!newCode || newCode.length < 4) {
          return reply('❌ Code kam se kam 4 characters ka hona chahiye. *.wishcode* dobara chalao.');
        }
        reply('🔁 Confirm karne ke liye *wahi naya code dobara* reply karo:');
        waitForReply(sock, chatId, sender, (confirmCode) => {
          if (confirmCode !== newCode) {
            return reply('❌ Dono codes match nahi hue. *.wishcode* dobara chalao.');
          }
          auth.setCode(newCode);
          reply('✅ Wish Mode access code successfully update ho gaya hai.');
        }, () => reply('⏱️ Time khatm. *.wishcode* dobara chalao.'));
      }, () => reply('⏱️ Time khatm. *.wishcode* dobara chalao.'));
    };

    if (!hadCode) {
      return askNew();
    }

    waitForReply(sock, chatId, sender, (currentCode) => {
      if (!auth.verifyCode(currentCode)) {
        return reply('❌ Current code galat hai. *.wishcode* dobara chalao.');
      }
      askNew();
    }, () => reply('⏱️ Time khatm. *.wishcode* dobara chalao.'));
  },
};
