/**
 * Facebook Downloader — multi-source fallback
 *
 * Source priority (tested on Replit 2026-05-02):
 *   1. v3.fdownloader.net  — reachable from Replit (200 JSON); works for truly public videos
 *   2. yt-dlp + cookies    — works anywhere once owner runs .setfbcookies
 *   3-6. snapsave / fdown / getfvid / sssinstagram — work from VPS / residential IP
 *
 * Cookie setup: owner sends  .setfbcookies c_user=... xs=... datr=...
 * Saves a Netscape-format cookie file → yt-dlp uses it to bypass the FB login wall.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const APIs = require('../../utils/api');
const { downloadBuffer, withFallback, probeSize } = require('../../utils/mediaDownloader');
const config = require('../../config');

const processed = new Set();
const COOKIES_FILE = path.join(__dirname, '..', '..', 'config', 'fb_cookies.txt');

const FB_PATTERNS = [
  /https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\//i,
  /https?:\/\/(?:www\.|m\.)?fb\.com\//i,
  /https?:\/\/fb\.watch\//i,
];

// ── Cookie helpers ────────────────────────────────────────────────────────────

/**
 * Parse "k1=v1; k2=v2" or "k1=v1 k2=v2" into a cookie map.
 * Accepts both semicolon-separated and space-separated formats.
 */
function parseCookieString(str) {
  const map = {};
  const parts = str.split(/[;\s]+/);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && v) map[k] = v;
  }
  return map;
}

/**
 * Write cookies in Netscape format (yt-dlp compatible).
 * Required cookies for Facebook: c_user, xs, datr (and optionally fr, sb)
 */
function writeFacebookCookies(cookieMap) {
  const now    = Math.floor(Date.now() / 1000);
  const expiry = now + 365 * 24 * 3600;   // 1 year
  const lines  = [
    '# Netscape HTTP Cookie File',
    '# Set by .setfbcookies — do not edit manually',
    '',
  ];
  for (const [name, value] of Object.entries(cookieMap)) {
    // domain  httpOnly  path  secure  expires  name  value
    lines.push(`.facebook.com\tTRUE\t/\tTRUE\t${expiry}\t${name}\t${value}`);
  }
  fs.mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });
  fs.writeFileSync(COOKIES_FILE, lines.join('\n') + '\n', 'utf8');
}

// ── Command ───────────────────────────────────────────────────────────────────

module.exports = {
  name    : 'facebook',
  aliases : ['fb', 'fbdl', 'facebookdl', 'setfbcookies'],
  category: 'media',
  description: 'Download Facebook videos (use .setfbcookies to enable cookie auth)',
  usage   : '.facebook <Facebook URL>',

  async execute(sock, msg, args, extra) {
    const reply = async (text) => {
      if (extra && typeof extra.reply === 'function') return extra.reply(text);
      return sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
    };

    const chatId  = (extra && extra.from) || msg.key.remoteJid;
    const sender  = msg.key.participant || msg.key.remoteJid;
    // Super owner (config.mainDeveloper) ya regular owner (config.ownerNumber) —
    // config se hi decide hota hai, koi hardcoded number nahi. (Pehle sirf
    // ownerNumber dekhta tha aur array ko .startsWith() deta tha, jo sirf
    // ek-number wali array ke liye kaam karta tha — ab dono fields aur
    // multiple numbers properly support hote hain.)
    const senderDigits = String(sender || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const isOwner = []
      .concat(config.mainDeveloper || [])
      .concat(config.ownerNumber || [])
      .some(n => String(n).replace(/[^0-9]/g, '') === senderDigits);
    const cmdName = (extra && extra.command) || (args[-1]) || '';

    // ── .setfbcookies handler ─────────────────────────────────────────────────
    const isSetCookies = (extra && extra.command === 'setfbcookies') ||
                         (args[0] || '').toLowerCase() === 'setcookies';

    if (
      msg.key.remoteJid?.endsWith('@s.whatsapp.net') &&   // private chat only
      (isSetCookies || (args[0] || '').includes('c_user=') || (args[0] || '').includes('xs='))
    ) {
      if (!isOwner) return reply('⛔ Only the bot owner can set Facebook cookies.');

      const cookieStr = args.join(' ').replace(/^setcookies\s*/i, '').trim();
      if (!cookieStr) {
        return reply(
          `*Facebook Cookie Setup*\n\n` +
          `Send your Facebook session cookies in this format:\n\n` +
          `\`.setfbcookies c_user=YOUR_UID xs=YOUR_XS datr=YOUR_DATR\`\n\n` +
          `*How to get cookies:*\n` +
          `1. Open Facebook in Chrome/Firefox\n` +
          `2. Press F12 → Application → Cookies → facebook.com\n` +
          `3. Copy values of: *c_user*, *xs*, *datr* (and optionally *fr*, *sb*)\n` +
          `4. Send them to the bot in the format above\n\n` +
          `⚠️ Keep your cookies private — they give full account access!`
        );
      }

      const cookieMap = parseCookieString(cookieStr);
      const required  = ['c_user', 'xs'];
      const missing   = required.filter(k => !cookieMap[k]);

      if (missing.length > 0) {
        return reply(`❌ Missing required cookies: *${missing.join(', ')}*\n\nRequired: c_user, xs\nOptional: datr, fr, sb`);
      }

      writeFacebookCookies(cookieMap);
      const keys = Object.keys(cookieMap).join(', ');
      return reply(
        `✅ *Facebook cookies saved!*\n\n` +
        `Cookies stored: ${keys}\n` +
        `File: config/fb_cookies.txt\n\n` +
        `Facebook downloads will now use your account cookies via yt-dlp.\n` +
        `Test it: _.facebook <any FB video URL>_`
      );
    }

    // ── Main download handler ─────────────────────────────────────────────────
    try {
      if (processed.has(msg.key.id)) return;
      processed.add(msg.key.id);
      setTimeout(() => processed.delete(msg.key.id), 5 * 60 * 1000);

      const url = args.join(' ').trim();
      if (!url) return reply('Please provide a Facebook video link.\nUsage: .facebook <url>');
      if (!FB_PATTERNS.some((p) => p.test(url))) {
        return reply('That is not a valid Facebook video link.');
      }

      try { await sock.sendMessage(chatId, { react: { text: '🔄', key: msg.key } }); } catch {}

      const result   = await withFallback(APIs.getFacebookSources(url), 'Facebook');
      const videoUrl = result.videoUrl;
      if (!videoUrl) throw new Error('No video URL found from any source');

      // Pick the right Referer based on which source delivered the URL:
      //   dl.snapcdn.app   → must use Referer: https://fdownloader.net/
      //   fbcdn.net direct → use Referer: https://www.facebook.com/
      const referer = /snapcdn\.app|fdownloader\.net/i.test(videoUrl)
        ? 'https://fdownloader.net/'
        : 'https://www.facebook.com/';

      // Smart size handling: probe first, switch to document if large
      const VIDEO_LIMIT = 50 * 1024 * 1024;
      const probe  = await probeSize(videoUrl, { headers: { Referer: referer } });
      const sizeMb = probe.size ? (probe.size / (1024 * 1024)).toFixed(1) + ' MB' : null;
      const title  = result.title || 'Facebook Video';
      const safe   = String(title).replace(/[^\w\s-]/g, '').slice(0, 80) || 'facebook';

      if (probe.size && probe.size > VIDEO_LIMIT) {
        await sock.sendMessage(chatId, {
          document : { url: videoUrl },
          mimetype : 'video/mp4',
          fileName : `${safe}.mp4`,
          caption  : `*${title}*\n📦 ${sizeMb} — sent as document\n\n> _Downloaded by ${config.botName}_`,
        }, { quoted: msg });
      } else {
        const buffer = await downloadBuffer(videoUrl, {
          headers: { Referer: referer },
          retries: 2,
        });

        // ── Corrupt/incomplete file guard ───────────────────────────────────
        // "Video not available, something is wrong with the file" usually
        // means the download broke midway (timeout/network hiccup) or the
        // source returned an error page instead of a real video, and the
        // bot still sent it blindly. A real MP4 always has an "ftyp" box
        // near the start of the file — if that's missing, the file is not
        // a valid video, so we don't send it; we retry the download once
        // instead of forwarding a broken file to the user.
        const isValidMp4 = (buf) => buf.length > 10000 && buf.slice(0, 32).includes('ftyp');
        let finalBuffer = buffer;
        if (!isValidMp4(finalBuffer)) {
          console.log('[FACEBOOK] ⚠️ Downloaded file looks corrupt/incomplete — retrying once...');
          finalBuffer = await downloadBuffer(videoUrl, {
            headers: { Referer: referer },
            retries: 2,
          });
          if (!isValidMp4(finalBuffer)) {
            throw new Error('Downloaded video file is corrupt or incomplete (source may be blocking/rate-limiting) — please try again in a bit');
          }
        }

        await sock.sendMessage(chatId, {
          video    : finalBuffer,
          mimetype : 'video/mp4',
          fileName : `${safe}.mp4`,
          caption  : `*${title}*${sizeMb ? `\n📦 ${sizeMb}` : ''}\n\n> _Downloaded by ${config.botName}_`,
        }, { quoted: msg });
      }

      try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
    } catch (err) {
      console.error('[FACEBOOK] error:', err?.message || err);
      try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}

      // Give a helpful error with cookie setup hint if all sources failed
      const hint = fs.existsSync(COOKIES_FILE)
        ? ''
        : '\n\n💡 _Tip: Set Facebook cookies with .setfbcookies for better success rate_';
      return reply(`❌ Failed to download Facebook video: ${err?.message || 'unknown error'}${hint}`);
    }
  },
};
