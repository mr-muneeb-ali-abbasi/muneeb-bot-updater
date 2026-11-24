/**
 * AI Chat Command — .ai <question>
 * Uses utils/aiEngine.js (keys from .aikey, live model discovery). The old third-party GET API was removed.
 */
const { askAI } = require('../../utils/aiEngine');

module.exports = {
  name: 'ai',
  aliases: ['gpt', 'chatgpt', 'ask'],
  category: 'ai',
  description: 'Chat with AI (ChatGPT-style)',
  usage: '.ai <question>',

  async execute(sock, msg, args, extra) {
    try {
      if (args.length === 0) {
        return extra.reply('❌ Usage: .ai <question>\n\nExample: .ai What is the capital of France?');
      }
      const question = args.join(' ');
      const sender = msg.key.participant || msg.key.remoteJid || 'ai-cmd';
      const r = await askAI({
        system: 'Tu ek helpful assistant hai. User ki zabaan (Urdu/Hinglish/English) mein saaf, sahi aur chhota jawab de.',
        user: question, maxTokens: 700, temperature: 0.6, userId: 'aicmd:' + sender,
      });
      if (!r || !r.text) {
        return extra.reply('❌ Abhi koi AI provider jawab nahi de raha. Owner ko bolo: *.aikey providers* se free key lekar *.aikey add* kare.');
      }
      await extra.reply(r.text);
    } catch (error) {
      await extra.reply(`❌ AI Error: ${error.message}`);
    }
  }
};
