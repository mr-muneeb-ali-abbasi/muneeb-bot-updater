'use strict';
/**
 * Wish Mode — private, consent-based content-library delivery
 * ─────────────────────────────────────────────────────────────
 * .wishmode on   → file list dikhata hai (jo bhi folder mein .txt files hain)
 * .wishmode off  → OWNER-ONLY, pura feature band kar deta hai
 *
 * Flow (isi command ke andar self-contained — handler.js ko chhua nahi gaya):
 *   1) File list dikhao (card + channel tag, jaisa .menu mein hai)
 *   2) User number bhej kar file choose kare
 *   3) "Close friends only" access code maangta hai (3 galat = 10 min lock,
 *      code kabhi log/menu/error mein print nahi hota)
 *   4) Code sahi milte hi bot poochta hai "yeh kiske liye hai" — naam type
 *      karo ya seedha @mention karo. Mention kiya to final message mein
 *      RECIPIENT aur SENDER dono ko tag kar deta hai.
 *   5) Us FILE ka POORA text, jaisa ka taisa, EK HI message mein (header ke
 *      saath) bhej deta hai — koi split, koi "quantity" wala concept nahi.
 *      Ek file = ek poora message. Alag-alag wishes chahiye to alag-alag
 *      files banao (ya *.wishadd* se WhatsApp se hi seedhi daal do).
 *
 * Har step ka apna 2-minute timeout hai — koi reply na aaye to flow khud
 * cancel ho jata hai, taaki listener hamesha ke liye latka na rahe.
 *
 * NOTE: internal data files (fightmoodState.json / fightmoodAuth.json /
 * data/fightmood-content/) ka naam jaan-bujh kar nahi badla — taaki pehle
 * se set kiya hua access code aur upload ki hui content files waisi hi
 * kaam karti rahein. Sirf USER-FACING command naam "Wish Mode" kiya hai.
 */

const fs     = require('fs');
const path   = require('path');
const config = require('../../config');
const state  = require('../../utils/fightmoodState');
const auth   = require('../../utils/fightmoodAuth');
const content = require('../../utils/fightmoodContent');
const { waitForReply } = require('../../utils/fightmoodFlow');

// WhatsApp ka text-message hard limit ~65,536 characters hai. Normal wishes
// isse bohot door hote hain, lekin agar koi file kabhi itni badi ho jaaye,
// yeh ek aakhri safety-valve hai (content-aware split nahi — sirf extreme
// edge-case ke liye raw length par, taaki bot crash na ho).
const HARD_SAFETY_LIMIT = 60000;

function _ownerList() {
  // Super owner (config.mainDeveloper) + regular owner (config.ownerNumber) —
  // dono config se, koi hardcoded number nahi.
  return []
    .concat(config.mainDeveloper || [])
    .concat(config.ownerNumber || [])
    .filter(Boolean).map(String);
}
function isOwner(sender) {
  const num = String(sender || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  return _ownerList().some(o => o.replace(/[^0-9]/g, '') === num);
}

function cardImagePath() {
  const p = path.join(__dirname, '..', '..', 'utils', 'bot_image.jpg');
  return fs.existsSync(p) ? p : null;
}

async function sendCard(sock, chatId, text, quotedMsg, mentions) {
  const img = cardImagePath();
  const contextInfo = {
    forwardingScore: 1,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
      newsletterJid: config.newsletterJid || '120363406636688300@newsletter',
      newsletterName: config.botName,
      serverMessageId: -1,
    },
  };
  if (mentions && mentions.length) contextInfo.mentionedJid = mentions;

  if (img) {
    await sock.sendMessage(chatId, {
      image: fs.readFileSync(img),
      caption: text,
      contextInfo,
    }, quotedMsg ? { quoted: quotedMsg } : undefined);
  } else {
    await sock.sendMessage(chatId, { text, contextInfo }, quotedMsg ? { quoted: quotedMsg } : undefined);
  }
}

module.exports = {
  name: 'wishmode',
  aliases: ['wish', 'wishbox'],
  category: 'owner',
  description: 'Private consent-based content-library delivery (close friends only)',
  usage: '.wishmode on | .wishmode off',

  async execute(sock, msg, args, extra) {
    const reply = extra && typeof extra.reply === 'function'
      ? extra.reply
      : (t) => sock.sendMessage(msg.key.remoteJid, { text: t }, { quoted: msg });

    const chatId = (extra && extra.from) || msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const sub = (args[0] || 'on').toLowerCase();

    if (sub === 'off') {
      if (!isOwner(sender)) return reply(config.messages?.ownerOnly || '❌ Only the bot owner can do this.');
      state.setEnabled(false);
      return reply('🛑 Wish Mode band kar diya gaya hai. Dobara chalu karne ke liye *.wishmode on*.');
    }

    if (!state.isEnabled()) {
      // Owner khud ".wishmode on" chala kar feature ko wapas chalu kar sakta hai
      if (sub === 'on' && isOwner(sender)) {
        state.setEnabled(true);
        await reply('✅ Wish Mode wapas chalu kar diya gaya hai.');
      } else {
        return reply('ℹ️ Yeh feature abhi band hai. Owner ko *.wishmode on* chalane ko bolo.');
      }
    }

    if (!auth.hasCode()) {
      if (isOwner(sender)) {
        return reply('⚠️ Access code set nahi hai. Pehle *.wishcode* se ek code set karo, tabhi yeh feature kaam karega.');
      }
      return reply('⚠️ Yeh feature abhi configure nahi hua hai. Bot owner se baat karo.');
    }

    const files = content.listFiles();
    if (!files.length) {
      const hint = isOwner(sender)
        ? `\n\n📁 Naya content add karne ke liye: ek .txt file *document* ke roop mein is chat mein bhejo, caption mein *.wishadd* likho — server mein jaane ki zaroorat nahi.`
        : '';
      return reply(`📭 Abhi koi content file available nahi hai.${hint}`);
    }

    let listText = `╭━━『 *${config.botName}* 』━━╮\n\n`;
    listText += `🎁 *Wish Mode — Content Library*\n\n`;
    listText += `Neeche se koi ek number reply karo:\n\n`;
    files.forEach((f, i) => {
      listText += `*${i + 1}.* ${f.displayName}\n`;
      listText += `   📦 ${f.sizeKb} KB\n\n`;
    });
    listText += `╰━━━━━━━━━━━━━━━━━╯\n`;
    listText += `⏱️ 2 minute ke andar number reply karo, warna yeh request khatm ho jayegi.`;

    await sendCard(sock, chatId, listText, msg);

    waitForReply(sock, chatId, sender, async (text) => {
      const idx = parseInt(text, 10);
      if (!Number.isInteger(idx) || idx < 1 || idx > files.length) {
        return reply('❌ Invalid selection. Dobara *.wishmode on* chala kar sahi number choose karo.');
      }
      const file = files[idx - 1];

      if (auth.isLocked(sender)) {
        const mins = Math.ceil(auth.remainingLockMs(sender) / 60000);
        return reply(`🔒 Bahut saare galat access code tries ho chuke hain. ${mins} minute baad dobara try karo.`);
      }

      await reply(
        `✅ Selected: *${file.displayName}*\n\n` +
        `🔐 *This feature is exclusively available to the developer's close friends.*\n` +
        `Please enter your access code to continue.`
      );

      waitForReply(sock, chatId, sender, async (codeText) => {
        if (!auth.verifyCode(codeText)) {
          auth.recordFailure(sender);
          if (auth.isLocked(sender)) {
            return reply(`❌ Galat code. Bahut saari koshish ho chuki — 10 minute ke liye lock ho gaya.`);
          }
          return reply(`❌ Galat access code. Dobara *.wishmode on* se try karo.`);
        }
        auth.recordSuccess(sender);

        // ── Naya step: kiske liye bhejni hai ────────────────────────────────
        await reply(
          `🎯 *Yeh paigham kiske liye hai?*\n\n` +
          `✏️ Unka naam type karo,\n` +
          `ya seedha unhe *@mention* karo (jaise @923001234567).`
        );

        waitForReply(sock, chatId, sender, async (nameText, nameMsg) => {
          const mentionedJid = nameMsg?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const recipientJid = mentionedJid.length ? mentionedJid[0] : null;
          const recipientLabel = recipientJid
            ? `@${recipientJid.split('@')[0]}`
            : (String(nameText || '').trim().slice(0, 60) || 'Aap');

          const { picked } = content.pickEntries(file.filename, 1);
          const full = picked[0];
          if (!full) {
            return reply('❌ Yeh file khaali nikli, kuch nahi mil saka.');
          }

          const senderDigits = String(sender).split('@')[0].split(':')[0];
          const mentions = [sender, recipientJid].filter(Boolean);

          const header =
            `🎯 *Kiske liye:* ${recipientLabel}\n` +
            `✍️ *Bheja gaya:* @${senderDigits}\n` +
            `━━━━━━━━━━━━━━━\n\n`;

          const finalText = header + full;

          // Poora file ka text JAISA KA TAISA ek hi message mein (header ke
          // saath) — koi split, koi numbering, kuch nahi. Sirf extreme-length
          // safety-valve (WhatsApp ki apni hard limit se bachne ke liye).
          if (finalText.length <= HARD_SAFETY_LIMIT) {
            await sendCard(sock, chatId, finalText, null, mentions);
          } else {
            const firstChunkLen = HARD_SAFETY_LIMIT - header.length;
            await sendCard(sock, chatId, header + full.slice(0, firstChunkLen), null, mentions);
            for (let i = firstChunkLen; i < full.length; i += HARD_SAFETY_LIMIT) {
              await sendCard(sock, chatId, full.slice(i, i + HARD_SAFETY_LIMIT));
            }
          }
        }, () => reply('⏱️ Time khatm ho gaya. Dobara *.wishmode on* se try karo.'));
      }, () => reply('⏱️ Time khatm ho gaya. Dobara *.wishmode on* se try karo.'));
    }, () => reply('⏱️ Time khatm ho gaya. Dobara *.wishmode on* se try karo.'));
  },
};
