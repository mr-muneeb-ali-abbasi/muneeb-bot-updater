'use strict';

/**
 * Update Command — GitHub-based auto-updater
 * ─────────────────────────────────────────────────────────────────────────
 * Source  : https://api.github.com/repos/mr-muneeb-ali-abbasi/muneeb-bot-updater/zipball/main
 * Version : https://raw.githubusercontent.com/mr-muneeb-ali-abbasi/muneeb-bot-updater/main/version.json
 *
 * PRESERVED (never overwritten):
 *   node_modules/  sessions/  session/  data/  tmp/  temp/
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
    https.get(url, {
      headers: { 'User-Agent': 'MuneebAliBot-Updater/2.0', 'Accept': 'application/json' },
      timeout: 10_000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
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

async function updateViaZip(zipUrl, statusFn) {
  const cwd    = process.cwd();
  const tmpDir = path.join(cwd, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const zipPath   = path.join(tmpDir, `update_${Date.now()}.zip`);
  const extractTo = path.join(tmpDir, `update_extract_${Date.now()}`);

  let copied;
  try {
    await statusFn('⬇️ Downloading update from GitHub…');
    await downloadFile(zipUrl, zipPath);

    await statusFn('📦 Extracting…');
    if (fs.existsSync(extractTo)) fs.rmSync(extractTo, { recursive: true, force: true });
    await extractZip(zipPath, extractTo);

    const entries       = fs.readdirSync(extractTo);
    const rootCandidate = entries.length === 1 ? path.join(extractTo, entries[0]) : extractTo;
    const srcRoot       = (fs.existsSync(rootCandidate) && fs.lstatSync(rootCandidate).isDirectory())
      ? rootCandidate : extractTo;

    await statusFn('📋 Copying new files (preserving your data)…');
    copied = copyRecursive(srcRoot, cwd, PRESERVE);

    // Server par pehle se galat-case folder (purana Commands/) pada ho to usse bhi sahi/merge kar do
    // (cache clear: abhi-abhi copy hui NAYI caseFix.js use ho, purani memory wali nahi)
    try {
      const cfPath = require.resolve('../../utils/caseFix');
      delete require.cache[cfPath];
      require(cfPath).fixCase(cwd);
    } catch (e) { console.warn('[Update] caseFix(cwd):', e.message); }
  } finally {
    // success ho ya fail — tmp ka zip / extract folder hamesha saaf (pehle fail par pada rehta tha)
    try { fs.rmSync(extractTo, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(zipPath); } catch {}
  }

  return copied;
}

module.exports = {
  name        : 'update',
  aliases     : ['upgrade', 'botupdate'],
  category    : 'owner',
  description : 'Update bot from GitHub (owner only)',
  usage       : '.update [zip_url]',
  ownerOnly   : true,

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;
    const zipUrl = (args[0] || GITHUB_ZIP_URL).trim();

    const statusMsg = await extra.reply('🔄 *Starting update…*');
    const statusKey = statusMsg?.key;

    const statusFn = async (text) => {
      if (statusKey) {
        try { await sock.sendMessage(chatId, { text, edit: statusKey }); } catch (_) {}
      }
      console.log('[Update]', text);
    };

    try {
      let localVer  = '1.0.0';
      let remoteVer = null;
      try { localVer = require('../../utils/localVersion').getLocalVersion().version; } catch (_) {}
      try {
        const remote = await fetchJson(VERSION_URL);
        remoteVer = remote?.version;
      } catch (_) {}

      if (remoteVer) {
        await statusFn(
          `📦 *Version check*\n• Local  : v${localVer}\n• Remote : v${remoteVer}\n\n⬇️ Downloading…`
        );
      }

      const copied = await updateViaZip(zipUrl, statusFn);

      // Install any new npm packages from the updated package.json
      try {
        await statusFn('📦 Installing dependencies…');
        await run('npm install --production --no-audit --no-fund', { cwd: process.cwd() });
      } catch (npmErr) {
        console.warn('[Update] npm install warning:', npmErr.message);
      }

      // ── Hot-reload: runs BEFORE success message so new commands are live ────
      const { loadCommands } = require('../../utils/commandLoader');

      // Snapshot of command names BEFORE reload (to detect what's new)
      const namesBefore = new Set();
      try { for (const [k, v] of loadCommands()) { if (v.name === k) namesBefore.add(k); } } catch (_) {}

      let reloadError = null;
      try {
        const { hotReloadCommands } = require('../../handler');
        hotReloadCommands();
        console.log('[Update] ✅ Hot-reload complete');
      } catch (hrErr) {
        reloadError = hrErr.message;
        console.warn('[Update] ⚠️ Hot-reload error:', hrErr.message);
      }

      // Snapshot AFTER reload — detect new commands
      const namesAfter  = new Set();
      const newCmds     = [];
      try {
        for (const [k, v] of loadCommands()) {
          if (v.name === k) {
            namesAfter.add(k);
            if (!namesBefore.has(k)) newCmds.push(k);
          }
        }
      } catch (_) {}

      // Read version directly from disk (bypasses require.cache completely)
      let newVer = remoteVer;
      try {
        newVer = require('../../utils/localVersion').getLocalVersion().version || newVer;
      } catch (_) {}

      const newCmdLine = newCmds.length
        ? `\n🆕 New commands: *${newCmds.join(', ')}*`
        : '';
      const reloadLine = reloadError
        ? `\n⚠️ Reload warning: ${reloadError} — run .restart for full effect`
        : `\n⚡ *${namesAfter.size} commands active (hot-reloaded — NO restart needed)*`;

      const summary =
        `✅ *Update complete!*\n\n` +
        `📁 Files updated : *${copied.length}*\n` +
        (newVer ? `📦 Version       : *v${newVer}*\n` : '') +
        newCmdLine +
        reloadLine +
        `\n\n🔒 Preserved: sessions, data, config.js, .env\n` +
        `✅ *Bot is still running — naye commands ABHI kaam kar rahe hain!*`;

      await statusFn(summary);
      // NO process.exit — bot stays running with hot-reloaded commands.
      // Core-file changes (handler.js etc.) need a manual .restart

    } catch (error) {
      console.error('[Update] Failed:', error);
      await statusFn(`❌ *Update failed:*\n${error.message}`);
    }
  },
};
