'use strict';
/**
 * .addsudo — kisi friend ke message par REPLY karke, ya use @mention karke,
 * use "sudo" bana do (short form: .asudo).
 *
 * Sudo user kya kar sakta hai:
 *   - Bot private/self mode mein ho tab bhi commands chala sakta hai (owner jaisa)
 *   - Mod-only commands chala sakta hai
 * Sudo user kya NAHI kar sakta:
 *   - ownerOnly aur superAdminOnly commands (.broadcast, .restart, .addsudo
 *     khud, .wishcode waghera) — yeh sirf asli owner/developer ke liye hi hain.
 *
 * Yeh sirf ISI bot (isi connected number) ke liye hai — dusre servers/numbers
 * par alag se add karna hoga.
 */
const sudo = require('../../utils/sudo');

function targetsFrom(msg, args) {
  const out = new Set();
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  for (const j of (ctx?.mentionedJid || [])) out.add(j);
  if (ctx?.participant) out.add(ctx.participant);   // jis message par reply kiya, uska bhejne wala
  for (const a of args) {
    const d = String(a).replace(/[^0-9]/g, '');
    if (d.length >= 8) out.add(d + '@s.whatsapp.net');
  }
  return [...out];
}

module.exports = {
  name: 'addsudo',
  aliases: ['asudo'],
  category: 'owner',
  description: 'Kisi ko sudo bana do — reply ya @mention karke (owner only)',
  usage: '.addsudo — kisi message par reply karke, ya kisi ko @mention karke likho',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const botId = extra.botId || sock.user?.id;
    const chatId = extra.from || msg.key.remoteJid;
    const targets = targetsFrom(msg, args);

    if (!targets.length) {
      return extra.reply('❌ Kisi ke message par *reply* karke ya unhe *@mention* karke *.addsudo* likho.');
    }

    const added = [];
    for (const jid of targets) {
      const num = sudo.digits(jid);
      if (num && sudo.addSudo(botId, num)) added.push(num);
    }
    if (!added.length) return extra.reply('❌ Kuch nahi hua — valid number nahi mila.');

    const mentions = added.map((n) => n + '@s.whatsapp.net');
    await sock.sendMessage(chatId, {
      text:
        `✅ *Sudo add ho gaya:*\n${added.map((n) => `• @${n}`).join('\n')}\n\n` +
        `Ab yeh is bot ke private/self mode mein bhi commands chala sakte hain ` +
        `(owner-only / super-admin-only commands ke alawa).`,
      mentions,
    }, { quoted: msg });
  },
};
