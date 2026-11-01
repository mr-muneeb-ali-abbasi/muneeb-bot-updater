'use strict';
/**
 * .settgtoken <token> — Telegram Bot API token save karta hai (.tgsticker ke liye zaroori hai).
 * Token @BotFather se milta hai (free, 2 minute ka kaam):
 *   1. Telegram app kholo, "@BotFather" ko message karo.
 *   2. "/newbot" bhejo, bot ka ek naam aur username do (username ke akhir mein "bot" hona chahiye).
 *   3. BotFather ek token dega jaisa: 123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   4. Yahan: .settgtoken 123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 */
const tg = require('../../utils/telegramConfig');

module.exports = {
  name: 'settgtoken',
  aliases: ['settelegramtoken', 'tgtoken'],
  category: 'owner',
  description: 'Telegram Bot API token save karo (.tgsticker ke liye chahiye)',
  usage: '.settgtoken <token>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const { reply } = extra;
    const token = (args[0] || '').trim();

    if (!token) {
      const cur = tg.getToken();
      return reply(
        `🔑 *Telegram Bot Token Setup*\n\n` +
        `Status: *${cur ? '✅ Set hai' : '❌ Set nahi hai'}*\n\n` +
        `*Kaise banayein (free, 2 minute):*\n` +
        `1️⃣ Telegram app mein "@BotFather" ko message karo\n` +
        `2️⃣ "/newbot" bhejo, bot ka naam aur username do\n` +
        `3️⃣ Wo ek token dega — jaisa: 123456789:AAFxxxxxxxxxxxxxxxxxxx\n` +
        `4️⃣ *.settgtoken <wo token paste karo>*\n\n` +
        `Iske baad *.tgsticker* command kaam karega.`
      );
    }

    if (!/^\d{6,}:[\w-]{30,}$/.test(token)) {
      return reply('❌ Ye token sahi format mein nahi lagta. @BotFather se mila hua poora token paste karo (jaisa: 123456789:AAFxxxx...).');
    }

    const ok = tg.setToken(token);
    return reply(ok ? '✅ Telegram Bot token save ho gaya! Ab *.tgsticker* use kar sakte ho.' : '❌ Token save nahi ho paya, dobara try karo.');
  },
};
