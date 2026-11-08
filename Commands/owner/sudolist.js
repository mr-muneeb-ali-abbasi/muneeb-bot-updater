'use strict';
/**
 * .sudolist — is bot ke abhi ke saare sudo users dikhata hai.
 * Short form: .sudos
 */
const sudo = require('../../utils/sudo');

module.exports = {
  name: 'sudolist',
  aliases: ['sudos'],
  category: 'owner',
  description: 'Is bot ke saare sudo users dikhao (owner only)',
  usage: '.sudolist',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const botId = extra.botId || sock.user?.id;
    const list = sudo.getSudoList(botId);
    if (!list.length) return extra.reply('📭 Abhi is bot par koi sudo user nahi hai.');

    const mentions = list.map((n) => n + '@s.whatsapp.net');
    await sock.sendMessage(extra.from || msg.key.remoteJid, {
      text: `👤 *Sudo users (is bot ke):*\n\n${list.map((n, i) => `${i + 1}. @${n}`).join('\n')}`,
      mentions,
    }, { quoted: msg });
  },
};
