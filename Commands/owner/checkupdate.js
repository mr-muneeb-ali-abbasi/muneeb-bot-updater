'use strict';

const https  = require('https');
const config = require('../../config');

// .update ke saath SAME repo (utils/updateSource.js) — URL har baar abhi compute hota hai (token baad mein bhi lag sakta hai)
const _src = require('../../utils/updateSource');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const u = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();   // GitHub raw cache todne ke liye
    const req = https.get(u, {
      headers: _src.headersFor(u, { 'User-Agent': 'MuneebAliBot/2.0', 'Accept': 'application/json', 'Cache-Control': 'no-cache' }),
      timeout: 10_000,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} from GitHub`)); }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data.replace(/^\uFEFF/, '').replace(/,(\s*[}\]])/g, '$1'))); }
        catch { reject(new Error('Invalid JSON from GitHub')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
  });
}

function semverGt(a, b) {
  const pa = String(a || '0.0.0').split('.').map(Number);
  const pb = String(b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

module.exports = {
  name        : 'checkupdate',
  aliases     : ['vcheck', 'version', 'ver'],
  category    : 'owner',
  description : 'Check if a new bot update is available on GitHub',
  usage       : '.checkupdate',
  ownerOnly   : true,

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;

    const statusMsg = await extra.reply('🔍 *Checking for updates…*');
    const editStatus = async (text) => {
      if (statusMsg?.key) {
        try { await sock.sendMessage(chatId, { text, edit: statusMsg.key }); } catch (_) {}
      }
    };

    try {
      let localVer = '1.0.0';
      let localDate = null;
      try {
        const lv  = require('../../utils/localVersion').getLocalVersion();   // version.json (update ke baad yahi badalta hai)
        localVer  = lv.version     || localVer;
        localDate = lv.releaseDate || null;
      } catch (_) {}

      await editStatus('📡 *Fetching remote version from GitHub…*');
      let remote;
      try { remote = await fetchJson(_src.versionUrl()); }
      catch (e1) {
        // token set but dead while the repo is still public → public URL
        if (_src.token()) { try { remote = await fetchJson(_src.publicVersionUrl()); } catch (_) { throw e1; } }
        else throw e1;
      }
      const remoteVer  = remote?.version  || 'unknown';
      const remoteDate = remote?.releaseDate || remote?.date || null;
      const changelog  = remote?.changelog || remote?.changes || null;

      const hasUpdate  = semverGt(remoteVer, localVer);
      const isUpToDate = !hasUpdate && !semverGt(localVer, remoteVer);

      let text =
        `╭━━━❰ 🔍 *VERSION CHECK* ❱━━━╮\n` +
        `┃\n` +
        `┃ 📦 Local  : *v${localVer}*${localDate ? ` (${localDate})` : ''}\n` +
        `┃ 🌐 Remote : *v${remoteVer}*${remoteDate ? ` (${remoteDate})` : ''}\n` +
        `┃\n`;

      if (hasUpdate) {
        text +=
          `┃ 🚀 *NEW UPDATE AVAILABLE!*\n` +
          `┃\n`;
        if (changelog) {
          text += `┃ 📋 *Changelog:*\n`;
          const lines = String(changelog).split('\n').slice(0, 5);
          for (const l of lines) text += `┃  • ${l.trim()}\n`;
          text += `┃\n`;
        }
        text +=
          `┃ ⬇️ Update karne ke liye:\n` +
          `┃  *${extra.prefix || '.'}update*\n` +
          `┃\n`;
      } else if (isUpToDate) {
        text += `┃ ✅ *Already up to date!*\n┃\n`;
      } else {
        text += `┃ ⚠️ Version mismatch — check manually\n┃\n`;
      }

      text +=
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `> *ᴘᴏᴡᴇʀᴇᴅ  ʙʏ ${config.botName || 'Bot'}*`;

      await editStatus(text);

    } catch (err) {
      console.error('[checkupdate]', err.message);
      await editStatus(
        `❌ *Version check failed!*\n\n` +
        `Error: ${_src.scrub(err.message)}${_src.explain(err)}\n\n` +
        `_Internet connection ya GitHub access check karo._`
      );
    }
  },
};
