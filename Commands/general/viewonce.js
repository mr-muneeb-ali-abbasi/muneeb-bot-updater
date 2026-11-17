/**
 * ViewOnce Command - Reveal view-once messages (.vv)
 *
 * WhatsApp ab reply ke andar view-once ka media link nahi deta, isliye pehle "No valid media URL or directPath"
 * aata tha. Ab bot view-once message AATE HI utils/viewOnceStore.js me save kar leta hai, aur .vv wahi se nikalta hai.
 * (Sirf wahi view-once nikal sakta hai jo bot ke online rehte aaya ho.)
 */

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const viewOnceStore = require('../../utils/viewOnceStore');

function reasonText(id, quotedInfo) {
  const st = viewOnceStore.status(id);
  let why;
  if (!st) why = 'Ye message bot tak pahuncha hi nahi.';
  else if (st.state === 'SEEN_NOT_VO') why = 'Ye view-once nahi hai, normal media hai.';
  else if (st.state === 'NOMEDIA') why = 'WhatsApp ne media link diya hi nahi (WhatsApp ki restriction).';
  else if (st.state === 'DLFAIL') why = 'Download fail ho gaya, link expire ho sakta hai.';
  else if (st.state === 'TOOBIG') why = 'Media bahut bada hai.';
  else why = 'Abhi save ho raha hai, thodi der baad .vv dobara karo.';
  return '⚠️ View-once reveal nahi hua — ' + why;
}

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
        return await sock.sendMessage(chatId, { text: reasonText(ctx.stanzaId, Object.keys(q).join(',')) }, { quoted: msg });
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
      const ctx2 = msg.message?.extendedTextMessage?.contextInfo || {};
      const text = /directPath|media URL|404|410|expired|decrypt/i.test(m)
        ? reasonText(ctx2.stanzaId, '')
        : '❌ Error processing view-once message: ' + (m || 'Unknown error');
      await sock.sendMessage(chatId, { text }, { quoted: msg });
    }
  },
};
