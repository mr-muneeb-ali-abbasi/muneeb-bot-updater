'use strict';
/**
 * .delsudo — kisi ka sudo access hata do (reply ya @mention karke).
 * Short form: .dsudo
 */
const sudo = require('../../utils/sudo');

function targetsFrom(msg, args) {
  const out = new Set();
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  for (const j of (ctx?.mentionedJid || [])) out.add(j);
  if (ctx?.participant) out.add(ctx.participant);
  for (const a of args) {
    const d = String(a).replace(/[^0-9]/g, '');
    if (d.length >= 8) out.add(d + '@s.whatsapp.net');
  }
  return [...out];
}

module.exports = {
  name: 'delsudo',
  aliases: ['dsudo', 'rmsudo'],
  category: 'owner',
  description: 'Kisi ka sudo access hata do — reply ya @mention karke (owner only)',
  usage: '.delsudo — kisi message par reply karke, ya kisi ko @mention karke likho',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const botId = extra.botId || sock.user?.id;
    const targets = targetsFrom(msg, args);

    if (!targets.length) {
      return extra.reply('❌ Kisi ke message par *reply* karke ya unhe *@mention* karke *.delsudo* likho.');
    }

    const removed = [];
    for (const jid of targets) {
      const num = sudo.digits(jid);
      if (num && sudo.removeSudo(botId, num)) removed.push(num);
    }
    if (!removed.length) return extra.reply('ℹ️ Yeh log sudo list mein the hi nahi.');

    return extra.reply(`✅ Sudo hata diya gaya: ${removed.map((n) => '+' + n).join(', ')}`);
  },
};
