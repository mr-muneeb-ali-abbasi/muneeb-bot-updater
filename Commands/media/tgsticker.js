'use strict';
/**
 * .tgsticker <telegram sticker pack link ya naam> — Telegram sticker pack download karke
 * WhatsApp stickers bana kar bhejta hai.
 *
 * Telegram ka public preview page (t.me/addstickers/<pack>) ab sirf ek "Add Stickers" button
 * deta hai, koi image URL nahi (scraping se kaam nahi chalta) — isliye ye command Telegram ka
 * OFFICIAL Bot API use karta hai (getStickerSet + getFile). Iske liye ek FREE Telegram Bot
 * Token chahiye: *.settgtoken* command dekho (setup 2 minute ka hai, @BotFather se).
 *
 * Usage:
 *   .tgsticker DonutTheDog
 *   .tgsticker https://t.me/addstickers/DonutTheDog
 *   .tgsticker DonutTheDog all      (default cap 25 ki jagah max 100 tak bhejta hai)
 *
 * Support: STATIC (.webp) + VIDEO/animated (.webm) stickers. Purana *.tgs (Lottie-JSON)*
 * format is waqt support nahi hai — render karne ke liye heavy cheez chahiye jo chhote/
 * low-RAM servers crash kar degi, isliye jaan-boojh kar chhoda gaya hai.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { exec } = require('child_process');
const webp = require('node-webpmux');
const ffmpegPath = require('ffmpeg-static');
const config = require('../../config');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');
const tg = require('../../utils/telegramConfig');

// kuch hosts Telegram ka domain block kar dete hain — agar ho to WARP tunnel se retry (optional)
let socksFetch = null;
try { socksFetch = require('../../utils/socksFetch'); } catch (_) {}
const _get = (url, opts) => (socksFetch && typeof socksFetch.get === 'function') ? socksFetch.get(url, opts) : axios.get(url, opts);

const DEFAULT_CAP = 25;
const MAX_CAP = 100;
const execPromise = (cmd) => new Promise((resolve, reject) => exec(cmd, (err) => (err ? reject(err) : resolve())));

function parsePackName(raw) {
  if (!raw) return '';
  let s = raw.trim();
  const tgMatch = s.match(/[?&]set=([A-Za-z0-9_]+)/);
  if (tgMatch) return tgMatch[1];
  s = s.replace(/^https?:\/\//i, '').replace(/^t\.me\//i, '').replace(/^telegram\.me\//i, '');
  s = s.replace(/^addstickers\//i, '').replace(/^@/, '');
  s = s.split(/[?#]/)[0].split('/')[0].trim();
  return s;
}

async function tgApi(token, method, params) {
  const res = await _get(`https://api.telegram.org/bot${token}/${method}`, { params, timeout: 20000 });
  if (!res.data || !res.data.ok) throw new Error(res.data?.description || `${method} failed`);
  return res.data.result;
}

async function toWaSticker(buffer, isVideo, packname, author) {
  const tempDir = getTempDir();
  const ts = Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  const tempInput = path.join(tempDir, `tgin_${ts}.${isVideo ? 'webm' : 'webp'}`);
  const tempOutput = path.join(tempDir, `tgout_${ts}.webp`);
  const tempFiles = [tempInput, tempOutput];
  try {
    fs.writeFileSync(tempInput, buffer);
    const cmd = isVideo
      ? `"${ffmpegPath}" -i "${tempInput}" -vf "scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -c:v libwebp -preset default -loop 0 -vsync 0 -pix_fmt yuva420p -quality 75 -compression_level 6 -t 7 "${tempOutput}"`
      : `"${ffmpegPath}" -i "${tempInput}" -vf "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -c:v libwebp -preset default -loop 0 -vsync 0 -pix_fmt yuva420p -quality 80 -compression_level 6 "${tempOutput}"`;
    await execPromise(cmd);
    let webpBuffer = fs.readFileSync(tempOutput);

    const img = new webp.Image();
    await img.load(webpBuffer);
    const json = {
      'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
      'sticker-pack-name': packname || config.packname || 'Telegram Stickers',
      'sticker-pack-publisher': author || config.botName || 'Mr.Muneeb Ali Bot',
      emojis: ['🤖'],
    };
    const exifAttr = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
    const exif = Buffer.concat([exifAttr, jsonBuffer]);
    exif.writeUIntLE(jsonBuffer.length, 14, 4);
    img.exif = exif;
    return await img.save(null);
  } finally {
    tempFiles.forEach((f) => deleteTempFile(f));
  }
}

module.exports = {
  name: 'tgsticker',
  aliases: ['tsticker', 'telesticker', 'tgstic'],
  description: 'Telegram sticker-pack download karke WhatsApp stickers banata hai (static + video/animated)',
  usage: '.tgsticker <pack-link ya naam> [all]',
  category: 'media',

  async execute(sock, msg, args, extra) {
    const { from, reply } = extra;
    try {
      const token = tg.getToken();
      if (!token) {
        return reply(
          `🔑 Isse pehle Telegram Bot Token set karna hoga (free, 2 minute).\n\n` +
          `Owner is command se set kar sakta hai: *.settgtoken*\n` +
          `(Wo command usage batayega ki @BotFather se token kaise le.)`
        );
      }

      if (!args[0]) {
        return reply(
          `📥 *Telegram Sticker Downloader*\n\n` +
          `Usage:\n` +
          `• *.tgsticker <pack-naam>*\n` +
          `• *.tgsticker https://t.me/addstickers/<pack-naam>*\n` +
          `• *.tgsticker <pack-naam> all* — zyada stickers (max ${MAX_CAP})\n\n` +
          `_Pack-naam link ke akhir mein hota hai, e.g. "DonutTheDog"._\n` +
          `✅ Static + video/animated (.webm) stickers dono support hain.\n` +
          `⚠️ Sirf purana *.tgs (Lottie)* format support nahi hai.`
        );
      }

      const packname = parsePackName(args[0]);
      if (!packname) return reply('❌ Pack link/naam samajh nahi aaya. *.tgsticker DonutTheDog* jaisa try karo.');

      const wantAll = (args[1] || '').toLowerCase() === 'all';
      const cap = wantAll ? MAX_CAP : DEFAULT_CAP;

      await reply(`🔎 "*${packname}*" pack dhoond raha hoon...`);

      let set;
      try {
        set = await tgApi(token, 'getStickerSet', { name: packname });
      } catch (e) {
        const msgLow = String(e.message || '').toLowerCase();
        if (msgLow.includes('not found')) return reply(`❌ "*${packname}*" naam ka koi sticker pack nahi mila. Link/naam dobara check karo.`);
        if (msgLow.includes('unauthorized')) return reply('❌ Telegram Bot Token galat/invalid hai. *.settgtoken* se dobara set karo.');
        return reply(`❌ Telegram se pack nahi mil paya: ${e.message}`);
      }

      const allStickers = set.stickers || [];
      if (!allStickers.length) return reply(`❌ "*${packname}*" pack khaali hai.`);

      const supported = allStickers.filter((s) => !(s.is_animated && !s.is_video)); // Lottie(.tgs) skip, webp/webm chalega
      const skippedTgs = allStickers.length - supported.length;
      if (!supported.length) {
        return reply(`⚠️ "*${packname}*" sirf purane *.tgs (Lottie)* format ke stickers ka pack hai — ye abhi support nahi hai (host crash hone ka risk hai, isliye jaan-boojh kar skip kiya hai).`);
      }

      const truncated = supported.length > cap;
      const batch = supported.slice(0, cap);
      await reply(
        `✅ *${batch.length}* sticker mile (pack: "${set.title || packname}")` +
        `${truncated ? `, pack bada hai — "all" likho zyada ke liye (max ${MAX_CAP})` : ''}` +
        `${skippedTgs ? `\n_(${skippedTgs} animated/.tgs sticker skip kiye)_` : ''}\nBhej raha hoon...`
      );

      let sent = 0, failed = 0;
      for (const st of batch) {
        try {
          const filePath = await tgApi(token, 'getFile', { file_id: st.file_id });
          const fileRes = await _get(`https://api.telegram.org/file/bot${token}/${filePath.file_path}`, { timeout: 25000, responseType: 'arraybuffer' });
          const stickerBuf = await toWaSticker(Buffer.from(fileRes.data), !!st.is_video, set.title || packname, config.botName);
          await sock.sendMessage(from, { sticker: stickerBuf });
          sent++;
        } catch (e) {
          failed++;
        }
        await new Promise((r) => setTimeout(r, 700)); // WhatsApp rate-limit se bachne ke liye gap
      }

      await reply(`🎉 Done! *${sent}* sticker bhej diye${failed ? `, ${failed} fail hue` : ''}.`);
    } catch (e) {
      console.error('[tgsticker]', e.message);
      return reply(`❌ Error: ${e.message}`);
    }
  },
};
