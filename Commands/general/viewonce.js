/**
 * ViewOnce Command - Reveal view-once messages (.vv)
 *
 * WhatsApp ab reply ke andar view-once ka media link nahi deta, isliye pehle "No valid media URL or directPath"
 * aata tha. Ab bot view-once message AATE HI utils/viewOnceStore.js me save kar leta hai, aur .vv wahi se nikalta hai.
 * (Sirf wahi view-once nikal sakta hai jo bot ke online rehte aaya ho.)
 */

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const viewOnceStore = require('../../utils/viewOnceStore');

const NOT_SAVED_TEXT =
  '⚠️ Ye view-once reveal nahi ho paya.\n\n' +
  'WhatsApp reply me view-once ka media nahi deta, aur bot ne ye message aate waqt save nahi kiya ' +
  '(message bot ke online hone se pehle ka hai, ya 1 ghante se purana hai, ya bahut bada tha).\n\n' +
  '👉 Naye view-once par turant reply karke .vv likho.';

async function sendRevealed(sock, chatId, msg, { type, buffer, caption, mimetype, ptt }) {
  if (type === 'video') {
    return sock.sendMessage(chatId, { video: buffer, caption, mimetype: mimetype || 'video/mp4' }, { quoted: msg });
  }
  if (type === 'image') {
    return sock.sendMessage(chatId, { image: buffer, caption, mimetype: mimetype || 'image/jpeg' }, { quoted: msg });
  }
  return sock.sendMessage(chatId, {
    audio: buffer, ptt: ptt !== false, mimetype: mimetype || 'audio/ogg; codecs=opus',
  }, { quoted: msg });
}

module.exports = {
  name: 'viewonce',
  aliases: ['readvo', 'read', 'vv', 'readviewonce'],
  category: 'general',
  description: 'Reveal view-once messages (images/videos/audio)',
  usage: '.viewonce (reply to view-once message)',

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    try {
      // Reply kisi bhi type ke message se ho sakta hai (text, image, video ...)
      const ctx = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || msg.message?.videoMessage?.contextInfo
        || msg.message?.buttonsResponseMessage?.contextInfo
        || msg.message?.listResponseMessage?.contextInfo;

      if (!ctx?.quotedMessage || !ctx?.stanzaId) {
        return await sock.sendMessage(chatId, { text: '🗑️ Reply to a *view-once* message to reveal it.' }, { quoted: msg });
      }

      // 1) Sabse pehle: bot ne ye message aate waqt save kiya tha? (sahi tareeka)
      const saved = await viewOnceStore.get(ctx.stanzaId);
      if (saved) {
        return await sendRevealed(sock, chatId, msg, saved);
      }

      // 2) Save nahi mila — quoted message se seedha try karo (purane WhatsApp versions / kuch cases me chalta hai)
      const u = viewOnceStore.unwrap(ctx.quotedMessage);
      const q = ctx.quotedMessage;
      const looksViewOnce = !!(u?.viewOnce || q.viewOnceMessageV2 || q.viewOnceMessageV2Extension || q.viewOnceMessage || q.viewOnce);
      if (!u || !looksViewOnce) {
        return await sock.sendMessage(chatId, { text: '❌ This is not a view-once message!' }, { quoted: msg });
      }
      if (!u.media.url && !u.media.directPath) {
        return await sock.sendMessage(chatId, { text: NOT_SAVED_TEXT }, { quoted: msg });
      }

      const stream = await downloadContentFromMessage(u.media, u.type);
      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

      return await sendRevealed(sock, chatId, msg, {
        type: u.type, buffer, caption: u.media.caption || '', mimetype: u.media.mimetype, ptt: u.media.ptt,
      });
    } catch (error) {
      console.error('Error in viewonce command:', error);
      const m = String(error?.message || '');
      const text = /directPath|media URL|404|410|expired|decrypt/i.test(m)
        ? NOT_SAVED_TEXT
        : '❌ Error processing view-once message: ' + (m || 'Unknown error');
      await sock.sendMessage(chatId, { text }, { quoted: msg });
    }
  },
};
