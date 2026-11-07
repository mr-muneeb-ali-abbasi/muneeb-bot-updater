'use strict';
/**
 * .wishadd — SUPER OWNER ONLY (Main Developer). Content .txt file ko seedha
 * WhatsApp se, is specific server ki Wish Mode library mein daal deta hai —
 * server ke file manager mein login karne ki koi zaroorat nahi.
 *
 * Use (dono tareeke chalenge):
 *   1) Apni .txt file ko "document" (📎 file attachment, photo/video ki
 *      tarah compress NAHI) ke roop mein bhejo, caption mein likho:
 *        .wishadd
 *      (chaho to caption mein naya naam bhi de sakte ho, jaise:
 *        .wishadd Sorry Message 3
 *       — warna file ka original naam use ho jayega)
 *   2) YA: kisi pehle se WhatsApp mein bheji hui .txt file par *reply*
 *      karke likho: .wishadd
 *
 * File seedha data/fightmood-content/ mein save hoti hai (jahan se
 * *.wishmode* apni list banata hai) — isi server ke liye, dusre servers
 * alag se karne honge.
 */

const fs   = require('fs');
const path = require('path');

let downloadMediaMessage = null;
try { ({ downloadMediaMessage } = require('@whiskeysockets/baileys')); } catch (_) {}

const CONTENT_DIR = path.join(__dirname, '..', '..', 'data', 'fightmood-content');

function sanitizeName(raw) {
  let base = String(raw || 'wish').trim();
  base = base.replace(/[\\/]/g, '').replace(/\.\./g, '');      // no path traversal
  if (!/\.txt$/i.test(base)) base += '.txt';
  base = base.replace(/[^a-zA-Z0-9 _\-\.]/g, '').trim();
  if (!base || base.toLowerCase() === '.txt') base = `wish_${Date.now()}.txt`;
  return base.slice(0, 100);
}

/** Document is either attached directly to this message, or to the message it replies to. */
function findDocument(msg, extra) {
  if (msg.message?.documentMessage) {
    return { doc: msg.message.documentMessage, dlMsg: msg };
  }
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (ctx?.quotedMessage?.documentMessage) {
    return {
      doc: ctx.quotedMessage.documentMessage,
      dlMsg: {
        key: {
          remoteJid: msg.key.remoteJid,
          id: ctx.stanzaId,
          participant: ctx.participant,
          fromMe: false,
        },
        message: ctx.quotedMessage,
      },
    };
  }
  if (extra?.quoted?.message?.documentMessage) {
    return { doc: extra.quoted.message.documentMessage, dlMsg: extra.quoted };
  }
  return null;
}

module.exports = {
  name: 'wishadd',
  aliases: ['addwish', 'wishupload'],
  category: 'owner',
  description: 'WhatsApp se seedha Wish Mode library mein .txt file add karo (super owner only)',
  usage: 'Document bhejo caption ".wishadd" ke saath, ya purani .txt file par reply karke .wishadd likho',
  superAdminOnly: true,

  async execute(sock, msg, args, extra) {
    const reply = extra && typeof extra.reply === 'function'
      ? extra.reply
      : (t) => sock.sendMessage(msg.key.remoteJid, { text: t }, { quoted: msg });

    if (!downloadMediaMessage) {
      return reply('❌ Is server par media-download module (@whiskeysockets/baileys) load nahi ho saka — package check karo.');
    }

    const found = findDocument(msg, extra);
    if (!found) {
      return reply(
        '📎 Pehle apni *.txt* content file ko *document* (file attachment) ke roop mein bhejo, caption mein *.wishadd* likho.\n\n' +
        'YA: kisi pehle se bheji hui .txt file par *reply* karke *.wishadd* likho.'
      );
    }

    const { doc, dlMsg } = found;
    const origName = doc.fileName || 'wish.txt';
    const looksText = /\.txt$/i.test(origName) || /text\/plain/i.test(doc.mimetype || '');
    if (!looksText) {
      return reply('❌ Sirf *.txt* files allowed hain. PDF/Word/image nahi chalega — plain text file bhejo.');
    }

    try {
      const buffer = await downloadMediaMessage(dlMsg, 'buffer', {}, {});
      const safeName = sanitizeName(args.join(' ').trim() || origName);

      fs.mkdirSync(CONTENT_DIR, { recursive: true });
      const dest = path.join(CONTENT_DIR, safeName);
      const existed = fs.existsSync(dest);
      fs.writeFileSync(dest, buffer);

      const kb = (buffer.length / 1024).toFixed(1);
      return reply(
        `${existed ? '🔁 File update ho gayi' : '✅ Nayi file add ho gayi'}: *${safeName.replace(/\.txt$/i, '')}*\n` +
        `📦 ${kb} KB — is server ki *.wishmode* list mein abhi se dikhegi.`
      );
    } catch (e) {
      console.error('[wishadd] error:', e.message);
      return reply(`❌ File save nahi ho saki: ${e.message}`);
    }
  },
};
