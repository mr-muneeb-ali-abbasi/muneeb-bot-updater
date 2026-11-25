'use strict';
/**
 * .updatetoken — lets the bot keep updating from a PRIVATE update repo.
 *
 *   .updatetoken <token>   save a READ-ONLY GitHub token (your message is deleted right away) and test it
 *   .updatetoken status    is a token set / does it work (the token itself is never shown)
 *   .updatetoken remove    forget the token
 *   .updatetoken help      how to create the token
 *
 * The token lives in data/updateToken.json (the data/ folder is never overwritten by .update) or in the env var
 * UPDATE_GITHUB_TOKEN. It is sent only to GitHub's API host. See utils/updateSource.js.
 */
const https = require('https');
const src   = require('../../utils/updateSource');

function ghGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: src.headersFor(url, { 'User-Agent': 'MuneebAliBot-Updater/2.0', Accept: 'application/vnd.github+json' }), timeout: 10_000 }, (res) => {
      res.resume(); resolve({ status: res.statusCode });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

/** can THIS token read the update repo's version.json? */
async function probe() {
  const r = await ghGet(src.versionUrl());
  if (r.status === 200) return { ok: true, text: '✅ Token kaam kar raha hai — update repo padh sakta hai.' };
  if (r.status === 401) return { ok: false, text: '❌ GitHub ne token reject kiya (galat / expire / revoke).' };
  if (r.status === 403) return { ok: false, text: '❌ GitHub ne mana kiya (rate-limit ya permission kam). Token mein *Contents: Read-only* do.' };
  if (r.status === 404) return { ok: false, text: '❌ Repo/file nahi mili — token ko *sirf is update repo* par *Contents: Read-only* permission do (repo select karna zaroori hai).' };
  return { ok: false, text: `❌ GitHub tak pohonch nahi paya (${r.error || 'HTTP ' + r.status}).` };
}

const HELP =
  '🔐 *Private update repo ke liye token*\n\n' +
  '1) GitHub → Settings → Developer settings → *Personal access tokens* → *Fine-grained tokens* → Generate new token\n' +
  '2) *Repository access:* Only select repositories → sirf update repo (muneeb-bot-updater)\n' +
  '3) *Permissions → Repository → Contents:* *Read-only* (aur kuch nahi)\n' +
  '4) Expiry lamba rakho (ya custom) — expire hone par updates ruk jayenge\n' +
  '5) Token copy karke yahan bhejo:  *.updatetoken <token>*\n\n' +
  '⚠️ Ye token har bot/server par alag se set karna padta hai (har bot ka apna data folder hota hai).\n' +
  'Token read-only hai: isse koi code badal nahi sakta, sirf padh sakta hai.';

module.exports = {
  name: 'updatetoken',
  aliases: ['updtoken', 'setupdatetoken'],
  category: 'owner',
  description: 'Set a read-only GitHub token so .update works with a private update repo',
  usage: '.updatetoken <token> | status | remove | help',
  ownerOnly: true,
  superAdminOnly: true,

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;
    const arg = String((args && args[0]) || '').trim();
    const sub = arg.toLowerCase();

    if (!arg || sub === 'help') return extra.reply(HELP);

    if (sub === 'status') {
      const has = !!src.token();
      if (!has) return extra.reply('🔓 Koi token set nahi hai. Agar update repo private hai to *.updatetoken help* dekho.');
      const p = await probe();
      return extra.reply(`🔐 Token set hai (${src.tokenSource() === 'env' ? 'env variable' : 'data file'}).\n${p.text}`);
    }

    if (sub === 'remove' || sub === 'delete' || sub === 'off') {
      const had = src.clearToken();
      return extra.reply(had ? '🗑️ Token hata diya. Ab update sirf *public* repo se chalega.' :
        (process.env.UPDATE_GITHUB_TOKEN ? 'ℹ️ Token env variable (UPDATE_GITHUB_TOKEN) mein hai — hosting panel se hatao.' : 'ℹ️ Koi saved token tha hi nahi.'));
    }

    // a token was pasted → remove the message first so it does not stay in the chat
    try { await sock.sendMessage(chatId, { delete: msg.key }); } catch (_) {}

    if (!src.isValidToken(arg)) {
      return extra.reply('❌ Ye GitHub token jaisa nahi lag raha (github_pat_… ya ghp_… se shuru hona chahiye). *.updatetoken help* dekho.');
    }
    try { src.setToken(arg); } catch (e) { return extra.reply('❌ Token save nahi ho saka: ' + src.scrub(e.message)); }

    const p = await probe();
    if (!p.ok) {
      return extra.reply(`${p.text}\n\nToken save ho gaya hai, par abhi kaam nahi kar raha. Theek karke dobara *.updatetoken <token>* bhejo, ya *.updatetoken remove*.`);
    }
    return extra.reply(`${p.text}\n\nAb repo private hone par bhi *.update* chalega. (Tumhara token wala message delete kar diya gaya — agar delete na hua ho to khud delete kar do.)`);
  },
};
