'use strict';
/**
 * Fight Mode — private, consent-based content-library delivery
 * ─────────────────────────────────────────────────────────────
 * .fightmood on   → file list dikhata hai (jo bhi folder mein .txt files hain)
 * .fightmood off  → OWNER-ONLY, pura feature band kar deta hai
 *
 * Flow (isi command ke andar self-contained — handler.js ko chhua nahi gaya):
 *   1) File list dikhao (card + channel tag, jaisa .menu mein hai)
 *   2) User number bhej kar file choose kare
 *   3) Kitni ALAG-ALAG entries chahiye (1–500) poochta hai
 *   4) "Close friends only" access code maangta hai (3 galat = 10 min lock,
 *      code kabhi log/menu/error mein print nahi hota)
 *   5) Sahi code milte hi N DISTINCT (kabhi duplicate nahi) entries us file
 *      se chun kar, usi chat mein (jahan command chalaya) chunks mein
 *      bhej deta hai — ek sath 100s rapid-fire messages NAHI, balki har
 *      chunk mein kayi alag wishes ikattha, beech mein chhota sa gap.
 *
 * Har step ka apna 2-minute timeout hai — koi reply na aaye to flow khud
 * cancel ho jata hai, taaki listener hamesha ke liye latka na rahe.
 */

const fs     = require('fs');
const path   = require('path');
const config = require('../../config');
const state  = require('../../utils/fightmoodState');
const auth   = require('../../utils/fightmoodAuth');
const content = require('../../utils/fightmoodContent');
const { waitForReply } = require('../../utils/fightmoodFlow');

const CHUNK_SIZE       = 40;     // ek message mein max itni entries
const CHUNK_GAP_MS     = 2000;   // chunks ke beech itna gap

function _ownerList() {
  const raw = config.ownerNumber;
  return (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(String);
}
function isOwner(sender) {
  const num = String(sender || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  return _ownerList().some(o => o.replace(/[^0-9]/g, '') === num);
}

function cardImagePath() {
  const p = path.join(__dirname, '..', '..', 'utils', 'bot_image.jpg');
  return fs.existsSync(p) ? p : null;
}

async function sendCard(sock, chatId, text, quotedMsg) {
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
  name: 'fightmood',
  aliases: ['fightmode'],
  category: 'owner',
  description: 'Private consent-based content-library delivery (close friends only)',
  usage: '.fightmood on | .fightmood off',

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
      return reply('🛑 Fight Mode band kar diya gaya hai. Dobara chalu karne ke liye *.fightmood on*.');
    }

    if (!state.isEnabled()) {
      // Owner khud ".fightmood on" chala kar feature ko wapas chalu kar sakta hai
      if (sub === 'on' && isOwner(sender)) {
        state.setEnabled(true);
        await reply('✅ Fight Mode wapas chalu kar diya gaya hai.');
      } else {
        return reply('ℹ️ Yeh feature abhi band hai. Owner ko *.fightmood on* chalane ko bolo.');
      }
    }

    if (!auth.hasCode()) {
      if (isOwner(sender)) {
        return reply('⚠️ Access code set nahi hai. Pehle *.fightcode* se ek code set karo, tabhi yeh feature kaam karega.');
      }
      return reply('⚠️ Yeh feature abhi configure nahi hua hai. Bot owner se baat karo.');
    }

    const files = content.listFiles();
    if (!files.length) {
      const hint = isOwner(sender)
        ? `\n\n📁 Server folder: \`data/fightmood-content/\`\nYahan \`.txt\` files daalo (ek file = ek category, har line/paragraph ek alag message).`
        : '';
      return reply(`📭 Abhi koi content file available nahi hai.${hint}`);
    }

    let listText = `╭━━『 *${config.botName}* 』━━╮\n\n`;
    listText += `🎁 *Fight Mode — Content Library*\n\n`;
    listText += `Neeche se koi ek number reply karo:\n\n`;
    files.forEach((f, i) => {
      listText += `*${i + 1}.* ${f.displayName}\n`;
      listText += `   📨 ${f.entryCount} messages available · 📦 ${f.sizeKb} KB\n\n`;
    });
    listText += `╰━━━━━━━━━━━━━━━━━╯\n`;
    listText += `⏱️ 2 minute ke andar number reply karo, warna yeh request khatm ho jayegi.`;

    await sendCard(sock, chatId, listText, msg);

    waitForReply(sock, chatId, sender, async (text) => {
      const idx = parseInt(text, 10);
      if (!Number.isInteger(idx) || idx < 1 || idx > files.length) {
        return reply('❌ Invalid selection. Dobara *.fightmood on* chala kar sahi number choose karo.');
      }
      const file = files[idx - 1];
      await reply(
        `✅ Selected: *${file.displayName}* (${file.entryCount} available)\n\n` +
        `Kitne ALAG messages chahiye? *1 se 500* ke beech ek number reply karo.`
      );

      waitForReply(sock, chatId, sender, async (qtyText) => {
        const qty = Number(qtyText);
        if (!Number.isInteger(qty) || qty < 1 || qty > 500) {
          return reply('❌ Invalid quantity. Sirf 1 se 500 ke beech ka pura number chahiye. Dobara *.fightmood on* chalao.');
        }

        if (auth.isLocked(sender)) {
          const mins = Math.ceil(auth.remainingLockMs(sender) / 60000);
          return reply(`🔒 Bahut saare galat access code tries ho chuke hain. ${mins} minute baad dobara try karo.`);
        }

        await reply(
          `🔐 *This feature is exclusively available to the developer's close friends.*\n` +
          `Please enter your access code to continue.`
        );

        waitForReply(sock, chatId, sender, async (codeText) => {
          if (!auth.verifyCode(codeText)) {
            const a = auth.recordFailure(sender);
            if (auth.isLocked(sender)) {
              return reply(`❌ Galat code. Bahut saari koshish ho chuki — 10 minute ke liye lock ho gaya.`);
            }
            return reply(`❌ Galat access code. Dobara *.fightmood on* se try karo.`);
          }
          auth.recordSuccess(sender);

          const { picked, available, capped } = content.pickEntries(file.filename, qty);
          if (!picked.length) {
            return reply('❌ Yeh file khaali nikli, kuch nahi mil saka.');
          }

          const note = capped < qty
            ? `\n\nℹ️ Sirf ${available} alag messages is file mein available the, isliye ${capped} bheje ja rahe hain.`
            : '';
          await reply(`✅ Access verified. *${picked.length}* alag "${file.displayName}" messages bheje ja rahe hain...${note}`);

          for (let i = 0; i < picked.length; i += CHUNK_SIZE) {
            const chunk = picked.slice(i, i + CHUNK_SIZE);
            const startNum = i + 1;
            let body = `╭━━『 *${file.displayName}* 』━━╮\n\n`;
            chunk.forEach((entry, j) => {
              body += `*${startNum + j}.* ${entry}\n\n`;
            });
            body += `╰━━━━━━━━━━━━━━━━━╯`;
            await sendCard(sock, chatId, body);
            if (i + CHUNK_SIZE < picked.length) {
              await new Promise(r => setTimeout(r, CHUNK_GAP_MS));
            }
          }
        }, () => reply('⏱️ Time khatm ho gaya. Dobara *.fightmood on* se try karo.'));
      }, () => reply('⏱️ Time khatm ho gaya. Dobara *.fightmood on* se try karo.'));
    }, () => reply('⏱️ Time khatm ho gaya. Dobara *.fightmood on* se try karo.'));
  },
};
