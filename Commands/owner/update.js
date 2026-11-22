'use strict';

/**
 * Update Command — GitHub-based auto-updater (v2: version-check + automatic restart)
 * ─────────────────────────────────────────────────────────────────────────
 * Source  : utils/updateSource.js (zip of the update repo + version.json of the SAME repo)
 *
 * .update          → version check → NAYA version ho to: download → files copy → khud RESTART (exit 42, watchdog turant relaunch).
 *                    Naya version na ho to "already latest" bolta hai — na download, na restart (baar-baar restart nahi lagta).
 * .update force    → version same ho tab bhi dobara download + restart (kharab update ko theek karne ke liye).
 * .update <zip_url>→ custom zip se (version check skip).
 *
 * Restart ke baad version.json naya hota hai, isliye agla `.update` "already latest" dega.
 * npm packages: agar package.json ki dependencies badli hon to tmp/pending-install flag likhta hai —
 * startup.js watchdog restart ke waqt (bot band hone par, poori RAM free) npm install chala deta hai.
 *
 * PRESERVED (never overwritten):
 *   node_modules/  sessions/  session/  data/  tmp/  temp/  bin/
 *   config.js  .env  cookies.txt  package-lock.json
 */

const { exec }  = require('child_process');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const http      = require('http');
const config    = require('../../config');

const _src = require('../../utils/updateSource');
const GITHUB_ZIP_URL = _src.zipUrl();
const VERSION_URL = _src.versionUrl() || config.updateVersionUrl ||
  'https://raw.githubusercontent.com/mr-muneeb-ali-abbasi/muneeb-bot-updater/main/version.json';

// Folders / files that MUST NOT be overwritten by an update
const PRESERVE = new Set([
  'node_modules', 'sessions', 'session', 'data', 'tmp', 'temp',
  'config.js', '.env', 'cookies.txt', 'package-lock.json',
  '.git', 'bin',
]);

const MAX_REDIRECTS = 8;

function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true, timeout: 120_000, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message || '').toString().slice(0, 500)));
      resolve((stdout || '').toString().trim());
    });
  });
}

async function extractZip(zipPath, outDir) {
  if (process.platform === 'win32') {
    await run(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force"`);
    return;
  }
  const tools = [
    () => run(`unzip -o '${zipPath}' -d '${outDir}'`),
    () => run(`7z x -y '${zipPath}' -o'${outDir}'`),
    () => run(`busybox unzip -o '${zipPath}' -d '${outDir}'`),
    () => run(`python3 -c "import zipfile; zipfile.ZipFile('${zipPath}').extractall('${outDir}')"`),
  ];
  for (const tool of tools) {
    try { await tool(); return; } catch (_) {}
  }
  throw new Error('No extraction tool found (tried unzip, 7z, busybox, python3)');
}

function downloadFile(url, dest, visited = new Set()) {
  return new Promise((resolve, reject) => {
    if (visited.has(url) || visited.size > MAX_REDIRECTS)
      return reject(new Error('Too many redirects'));
    visited.add(url);

    const client = url.startsWith('https://') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'MuneebAliBot-Updater/2.0',
        'Accept'    : 'application/octet-stream, */*',
      },
      timeout: 60_000,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error(`HTTP ${res.statusCode} no Location`));
        res.resume();
        return downloadFile(new URL(loc, url).toString(), dest, visited).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode} from server`));

      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error',  err => { try { file.close(() => {}); } catch {} fs.unlink(dest, () => reject(err)); });
    });
    req.on('error',   err => { fs.unlink(dest, () => reject(err)); });
    req.on('timeout', ()  => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    // ?t= : GitHub raw ka cache todne ke liye (purana version.json na mile)
    const u = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    const req = https.get(u, {
      headers: { 'User-Agent': 'MuneebAliBot-Updater/2.0', 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
      timeout: 10_000,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} (version.json nahi mila)`)); }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data.replace(/^\uFEFF/, '').replace(/,(\s*[}\]])/g, '$1'))); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Version check timed out')); });
  });
}

function copyRecursive(src, dest, preserve, relPath = '', copied = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (preserve.has(entry)) continue;
    const srcPath  = path.join(src,  entry);
    const destPath = path.join(dest, entry);
    const stat     = fs.lstatSync(srcPath);
    if (stat.isSymbolicLink()) continue;          // zip ke andar ke shortcuts copy nahi karte (EISDIR error wajah)
    if (stat.isDirectory()) {
      copyRecursive(srcPath, destPath, new Set(), path.join(relPath, entry), copied);
    } else {
      fs.copyFileSync(srcPath, destPath);
      copied.push(path.join(relPath, entry).replace(/\\/g, '/'));
    }
  }
  return copied;
}

// ── helpers for the version check / dependency check ────────────────────────────
function semverGt(a, b) {
  const p = v => String(v || '0').replace(/[^0-9.]/g, '').split('.').map(n => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

function readVersionFile(dir) {
  try {
    const j = JSON.parse(String(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).replace(/^\uFEFF/, ''));
    return j && j.version ? String(j.version) : null;
  } catch (_) { return null; }
}

function depsSnapshot(dir) {          // package.json ki dependencies (sorted) — badli ya nahi, ye jaanchne ke liye
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const sort = o => Object.fromEntries(Object.entries(o || {}).sort(([a], [b]) => (a < b ? -1 : 1)));
    return JSON.stringify({ d: sort(p.dependencies), o: sort(p.optionalDependencies), v: sort(p.overrides) });
  } catch (_) { return ''; }
}

// Test ke liye har bahari kaam ek jagah (D) — production mein yehi asli functions hain.
const D = {
  fetchJson, downloadFile, extractZip,
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  exit: (code) => process.exit(code),
};

async function updateViaZip(zipUrl, statusFn, { localVer, force }) {
  const cwd    = process.cwd();
  const tmpDir = path.join(cwd, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const zipPath   = path.join(tmpDir, `update_${Date.now()}.zip`);
  const extractTo = path.join(tmpDir, `update_extract_${Date.now()}`);

  try {
    await statusFn('⬇️ Naya code download ho raha hai…');
    await D.downloadFile(zipUrl, zipPath);

    await statusFn('📦 Extract ho raha hai…');
    if (fs.existsSync(extractTo)) fs.rmSync(extractTo, { recursive: true, force: true });
    await D.extractZip(zipPath, extractTo);

    const entries       = fs.readdirSync(extractTo);
    const rootCandidate = entries.length === 1 ? path.join(extractTo, entries[0]) : extractTo;
    const srcRoot       = (fs.existsSync(rootCandidate) && fs.lstatSync(rootCandidate).isDirectory())
      ? rootCandidate : extractTo;

    // Zip ka apna version dekho: GitHub ka raw version.json kabhi kabhi zip se pehle badal jata hai.
    // Zip abhi purana ho to files copy mat karo (warna restart ke baad bhi purana version rehta aur loop banta).
    const zipVer = readVersionFile(srcRoot);
    if (!force && zipVer && !semverGt(zipVer, localVer)) {
      return { skipped: true, zipVer, copied: [], depsChanged: false };
    }

    const depsBefore = depsSnapshot(cwd);

    await statusFn('📋 Nayi files copy ho rahi hain (tumhara data safe rehta hai)…');
    const copied = copyRecursive(srcRoot, cwd, PRESERVE);

    // Server par pehle se galat-case folder (purana Commands/) pada ho to usse bhi sahi/merge kar do
    try {
      const cfPath = require.resolve('../../utils/caseFix');
      delete require.cache[cfPath];
      require(cfPath).fixCase(cwd);
    } catch (e) { console.warn('[Update] caseFix(cwd):', e.message); }

    const depsChanged = depsBefore !== depsSnapshot(cwd);
    return { skipped: false, zipVer, copied, depsChanged };
  } finally {
    // success ho ya fail — tmp ka zip / extract folder hamesha saaf
    try { fs.rmSync(extractTo, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(zipPath); } catch {}
  }
}

let _updating = false;

module.exports = {
  name        : 'update',
  aliases     : ['upgrade', 'botupdate'],
  category    : 'owner',
  description : 'Update bot from GitHub — version check, phir khud restart (owner only)',
  usage       : '.update  |  .update force  |  .update <zip_url>',
  ownerOnly   : true,
  _deps       : D,       // sirf tests ke liye

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;
    const arg0   = String((args && args[0]) || '').trim();
    const customZip = /^https?:\/\//i.test(arg0) ? arg0 : null;
    const force  = customZip !== null || /^(force|-f|--force)$/i.test(arg0);
    const zipUrl = customZip || GITHUB_ZIP_URL;

    if (_updating) return extra.reply('⏳ Update pehle se chal raha hai — thodi der ruko.');
    _updating = true;

    const statusMsg = await extra.reply('🔍 *Update check ho raha hai…*');
    const statusKey = statusMsg?.key;
    const statusFn = async (text) => {
      if (statusKey) {
        try { await sock.sendMessage(chatId, { text, edit: statusKey }); } catch (_) {}
      }
      console.log('[Update]', String(text).replace(/\n/g, ' | '));
    };

    let restarting = false;
    try {
      let localVer = '1.0.0';
      try { localVer = require('../../utils/localVersion').getLocalVersion().version; } catch (_) {}

      // ── 1) version check — naya version na ho to yahin ruk jao (na download, na restart) ──
      let remoteVer = null;
      if (!customZip) {
        try {
          const remote = await D.fetchJson(VERSION_URL);
          remoteVer = remote && remote.version ? String(remote.version) : null;
        } catch (e) {
          if (!force) {
            return await statusFn(`❌ *Version check fail hua:* ${e.message}\n\nThodi der baad dobara try karo, ya zabardasti update ke liye *.update force* likho.`);
          }
        }
        if (!remoteVer && !force) {
          return await statusFn('❌ *Remote version nahi mila.*\n\nThodi der baad try karo, ya *.update force* likho.');
        }
        if (!force && !semverGt(remoteVer, localVer)) {
          return await statusFn(
            `✅ *Bot already latest hai!*\n\n📦 Tumhara version : *v${localVer}*\n🌐 Latest version  : *v${remoteVer}*\n\n` +
            `Koi update nahi mila, isliye restart bhi nahi hua.\n_(Zabardasti dobara lagana ho to *.update force* likho.)_`
          );
        }
      }

      await statusFn(
        `🚀 *Naya update mila!*\n\n📦 Abhi : *v${localVer}*\n🆕 Naya : *v${remoteVer || '?'}*${force && !customZip ? '\n⚙️ (force mode)' : ''}\n\n⬇️ Download shuru…`
      );

      // ── 2) download + copy ──
      const res = await updateViaZip(zipUrl, statusFn, { localVer, force });

      if (res.skipped) {
        return await statusFn(
          `⏳ *Update abhi tayyar nahi hua.*\n\nVersion check ne *v${remoteVer}* dikhaya, par download hui zip abhi *v${res.zipVer}* hai ` +
          `(GitHub ko sync hone mein 1-5 minute lagte hain).\n\nBot ko *restart nahi kiya*. 2-5 minute baad dobara *.update* likho.`
        );
      }
      if (!res.copied.length) throw new Error('Zip mein koi file nahi mili — update nahi hua.');

      // ── 3) packages badle hon to watchdog ko batao (restart ke waqt npm install chalega) ──
      if (res.depsChanged) {
        try {
          const dir = path.join(process.cwd(), 'tmp');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'pending-install'), String(Date.now()));
        } catch (e) { console.warn('[Update] pending-install flag nahi likha:', e.message); }
      }

      let newVer = res.zipVer || remoteVer;
      try { newVer = require('../../utils/localVersion').getLocalVersion().version || newVer; } catch (_) {}

      // ── 4) restart ke baad owner ko "update ho gaya" ka message dene ke liye yaad rakho ──
      try {
        const dataDir = path.join(process.cwd(), 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        const botNum = String((sock.user && sock.user.id) || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
        fs.writeFileSync(path.join(dataDir, 'updateResult.json'),
          JSON.stringify({ jid: chatId, number: botNum, from: localVer, to: newVer, files: res.copied.length, at: Date.now() }));
      } catch (_) {}

      await statusFn(
        `✅ *Update ho gaya!*\n\n📁 Files updated : *${res.copied.length}*\n📦 Version : *v${localVer}* → *v${newVer}*\n` +
        (res.depsChanged ? `📚 Naye packages restart ke waqt install honge (2-6 min lag sakte hain)\n` : '') +
        `\n🔒 Safe rahe: sessions, data, config.js, .env\n\n🔁 *Bot ab khud restart ho raha hai…*\nKuch der mein wapas online aa jayega (hosting par jaane ki zaroorat nahi).`
      );

      // ── 5) automatic restart: exit 42 = watchdog (startup.js) turant dobara chala deta hai ──
      // Watchdog (WATCHDOG=1) ya PM2 ke bina exit karne se bot MAR jata (koi wapas chalane wala nahi) — tab exit nahi karte.
      const supervised = process.env.WATCHDOG === '1' || process.env.pm_id !== undefined;
      if (!supervised) {
        return await statusFn(
          `⚠️ *Files update ho gayi, par auto-restart nahi ho sakta* (bot watchdog ke bina chal raha hai).\n\n` +
          `Hosting panel se ek baar *Restart* dabao — ya server ko *npm start* / *node startup.js* se chalao taa ki aage se khud restart ho.`
        );
      }
      restarting = true;
      await D.sleep(3500);          // message delivery ke liye thoda waqt
      D.exit(42);
    } catch (error) {
      console.error('[Update] Failed:', error);
      await statusFn(`❌ *Update fail hua:*\n${error.message}\n\nBot restart nahi hua, purana code chal raha hai.`);
    } finally {
      if (!restarting) _updating = false;
    }
  },
};
