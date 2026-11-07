/**
 * WATCHDOG v3 — Production-grade bot supervisor
 *
 * Features:
 *  • Spawns index.js as a child process with optimised Node.js flags
 *  • Unlimited auto-restart with exponential back-off (3 s → 30 s cap)
 *  • Crash-loop guard: 5 crashes in 2 min → 60 s cool-down before next try
 *  • Forwards SIGTERM / SIGINT to child for graceful shutdown
 *  • Memory monitor: logs heap + OS RAM every 5 min
 *  • Keep-alive HTTP self-ping every 4 min (prevents Replit / hosting sleep)
 *  • PM2-compatible (PM2 handles outer restarts; watchdog handles inner ones)
 *
 * Restart codes from child:
 *   exit(0)  → clean stop (OS / Replit shutdown) — watchdog also stops
 *   exit(42) → intentional restart (.restart command) — immediate relaunch
 *   anything else → crash → watchdog restarts with back-off
 */

'use strict';

// ── Folder-name case auto-fix (Commands -> commands, panel -> Panel ...) — sab kuch load hone se pehle ──
try { require('./utils/caseFix').fixCase(__dirname); } catch (e) { console.warn('[CaseFix] skipped:', e.message); }


const { spawn } = require('child_process');
const http      = require('http');
const https     = require('https');
const os        = require('os');
const path      = require('path');
const fs        = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const RESTART_EXIT_CODE   = 42;
const BASE_DELAY_MS       = 3_000;
const MAX_DELAY_MS        = 30_000;
const CRASH_WINDOW_MS     = 2 * 60 * 1000;  // 2-min window for loop detection
const CRASH_LOOP_THRESH   = 5;               // 5 crashes in window = loop
const CRASH_LOOP_WAIT_MS  = 60_000;          // cool-down in crash loop
const PANEL_PORT          = process.env.SERVER_PORT || process.env.PORT || 5000;
const KEEP_ALIVE_MS       = 3 * 60 * 1000;  // ping every 3 min (was 4)
const MEM_LOG_MS          = 5 * 60 * 1000;  // log RAM every 5 min

// Replit public domain — must be pinged externally to prevent container sleep
const REPLIT_DOMAIN = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAIN || null;

// Ensure logs/ directory exists so PM2 log files can be written
try { fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true }); } catch (_) {}

// ── Real RAM limit of this container (cgroup v2 / v1), falls back to OS total ──
function memLimitMB() {
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      const n = Number(v);
      if (v !== 'max' && n > 0 && n < 1e13) return Math.round(n / 1048576);
    } catch (_) {}
  }
  return Math.round(os.totalmem() / 1048576);
}
const LIMIT_MB = memLimitMB();
// heap cap = 60% of the container RAM (max 640): 512 MB host → 307 MB, 1 GB host → 614 MB
const HEAP_MB  = Math.max(192, Math.min(640, Math.floor(LIMIT_MB * 0.6)));

// ── Dependency self-heal ──────────────────────────────────────────────────────
// Some hosts (512 MB RAM) stop `npm install` half-way ("Cannot find module 'debug'").
// Before launching, check the modules the bot really needs and install what is missing.
const REQUIRED_MODULES = ['express', 'debug', 'finalhandler', 'axios', 'pino', 'socket.io', 'qrcode', 'qrcode-terminal',
  'moment-timezone', 'node-fetch', 'form-data', 'sharp', 'node-webpmux', 'msedge-tts', 'gtts', 'yt-search', 'fluent-ffmpeg',
  'ffmpeg-static', 'mumaker', 'ruhend-scraper', 'cloudflared', 'localtunnel', '@whiskeysockets/baileys', '@bochilteam/scraper-tiktok'];
// Is package `name` installed, as seen from folder `fromDir`? Returns the package folder or null.
function findPackageDir(name, fromDir) {
  try { return path.dirname(require.resolve(name + '/package.json', { paths: [fromDir] })); }
  catch (e) { /* packages that hide package.json via "exports": walk up the node_modules folders instead */ }
  for (let dir = fromDir, prev = null; dir && dir !== prev; prev = dir, dir = path.dirname(dir)) {
    const cand = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}
// A half-finished npm install usually loses INNER packages ("Cannot find module 'content-type'" — needed by express),
// not the top-level ones. So walk the whole dependency tree of every required module and report what is gone.
function missingModules() {
  const out = new Set(), seen = new Set();
  const walk = (name, fromDir) => {
    const dir = findPackageDir(name, fromDir);
    if (!dir) { out.add(name); return; }
    if (seen.has(dir)) return;
    seen.add(dir);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
    catch (_) { out.add(name); return; }          // folder exists but its package.json is gone / broken
    for (const dep of Object.keys(meta.dependencies || {})) walk(dep, dir);
  };
  for (const m of REQUIRED_MODULES) walk(m, __dirname);
  return [...out];
}
// Small hosts have a hard disk quota (Katabump: 716 MiB). npm's download cache and half-finished update leftovers
// can push the bot folder over it → the host refuses to start the server. None of this is ever needed again.
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function trimDisk() {
  try {
    const tmp = path.join(__dirname, 'tmp');
    if (fs.existsSync(tmp)) for (const n of fs.readdirSync(tmp)) if (/^(update_|npm-cache)/.test(n)) rmrf(path.join(tmp, n));
    const home = process.env.HOME || os.homedir();
    for (const d of ['_cacache', '_logs', '_npx']) rmrf(path.join(home, '.npm', d));
    for (const d of ['puppeteer', 'ms-playwright', 'node-gyp', 'pip', 'yarn', 'npm']) rmrf(path.join(home, '.cache', d));
  } catch (_) {}
}
// npm's download cache is big (hundreds of MB). /tmp is normally NOT counted against the hosting disk quota,
// so use it when it has room; otherwise fall back to a folder inside the bot (trimDisk() removes it afterwards).
function npmCacheDir() {
  try {
    const st = fs.statfsSync('/tmp');
    if (st.bavail * st.bsize > 700 * 1024 * 1024) { const d = '/tmp/muneeb-npm-cache'; fs.mkdirSync(d, { recursive: true }); return d; }
  } catch (_) {}
  return path.join(__dirname, 'tmp', 'npm-cache');
}
// One line per big folder, so "disk full" is never a guess (needs the `du` tool, present on normal Linux hosts).
function diskReport() {
  try {
    const home = process.env.HOME || os.homedir();
    const rows = [];
    const du = (p) => { try { return parseInt(require('child_process').execFileSync('du', ['-sk', p], { timeout: 25000 }).toString(), 10) || 0; } catch (_) { return null; } };
    const names = ['node_modules', 'sessions', 'data', 'database', 'temp', 'tmp', 'logs', 'bin', 'commands', 'utils', 'Panel'];
    for (const n of names) { const p = path.join(__dirname, n); if (fs.existsSync(p)) { const k = du(p); if (k === null) return; rows.push([n, k]); } }
    for (const n of ['.cache', '.npm', '.npm-global', '.tmp']) { const p = path.join(home, n); if (fs.existsSync(p)) { const k = du(p); if (k !== null) rows.push([n, k]); } }
    const total = rows.reduce((a, r) => a + r[1], 0);
    rows.sort((x, y) => y[1] - x[1]);
    console.log('[WATCHDOG] 💾 Disk: ' + rows.filter(r => r[1] > 2048).map(r => `${r[0]} ${Math.round(r[1] / 1024)}MB`).join(' | ') + ` | total ~${Math.round(total / 1024)}MB`);
    const nm = path.join(__dirname, 'node_modules');
    if (fs.existsSync(nm)) {
      const subs = [];
      for (const n of fs.readdirSync(nm)) {
        if (n.startsWith('.')) continue;
        if (n.startsWith('@')) { for (const m of fs.readdirSync(path.join(nm, n))) { const k = du(path.join(nm, n, m)); if (k) subs.push([n + '/' + m, k]); } }
        else { const k = du(path.join(nm, n)); if (k) subs.push([n, k]); }
      }
      subs.sort((x, y) => y[1] - x[1]);
      console.log('[WATCHDOG] 📦 Sabse bade packages: ' + subs.slice(0, 8).map(r => `${r[0]} ${Math.round(r[1] / 1024)}MB`).join(' | '));
    }
  } catch (_) {}
}
function ensureDependencies(force = false) {
  if (process.env.SKIP_DEP_CHECK === '1') return;
  trimDisk();
  if (!force) diskReport();
  let miss = missingModules();
  if (!miss.length && !force) return;
  console.log(force && !miss.length
    ? '[WATCHDOG] 📦 Update ne naye packages maange hain — npm install chal raha hai (2-6 min lag sakte hain)...'
    : `[WATCHDOG] 📦 ${miss.length} module missing (${miss.slice(0, 6).join(', ')}${miss.length > 6 ? '…' : ''}) — npm install chal raha hai (2-6 min lag sakte hain)...`);
  for (let attempt = 1; attempt <= 2 && (miss.length || (force && attempt === 1)); attempt++) {
    try {
      require('child_process').execSync(
        'npm install --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error --ignore-scripts=false',
        { cwd: __dirname, stdio: 'inherit', timeout: 15 * 60 * 1000,
          env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${Math.max(160, Math.floor(LIMIT_MB * 0.55))}`,
                 PUPPETEER_SKIP_DOWNLOAD: 'true', PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true', npm_config_maxsockets: '3',
                 npm_config_cache: npmCacheDir() } }
      );
    } catch (e) { console.error(`[WATCHDOG] ⚠️ npm install attempt ${attempt} fail: ${String(e.message).split('\n')[0]}`); }
    trimDisk();
    miss = missingModules();
  }
  if (miss.length) console.error(`[WATCHDOG] ❌ Ye modules abhi bhi missing hain: ${miss.join(', ')}\n   Hosting console mein chalao: npm install ${miss.join(' ')}`);
  else console.log('[WATCHDOG] ✅ Saare zaroori modules install ho gaye.');
}

// Node.js flags passed to child process
const NODE_FLAGS = [
  `--max-old-space-size=${HEAP_MB}`,   // heap cap follows the real container RAM (buffers/ffmpeg live outside heap)
  '--require', './utils/memoryGuard.js', // auto-restart on RAM overrun / frozen loop
  '--expose-gc',                 // allow manual GC from code
  '--optimize-for-size',         // trade speed for lower memory
];

let restartCount  = 0;
let recentCrashes = [];
let child         = null;

// ── Memory monitor ───────────────────────────────────────────────────────────
setInterval(() => {
  try {
    const m      = process.memoryUsage();
    const freeMB = Math.round(os.freemem()   / 1024 / 1024);
    const totMB  = Math.round(os.totalmem()  / 1024 / 1024);
    console.log(
      `[WATCHDOG] 📊 Heap: ${Math.round(m.heapUsed/1024/1024)}/${Math.round(m.heapTotal/1024/1024)} MB` +
      ` | RSS: ${Math.round(m.rss/1024/1024)} MB` +
      ` | System free: ${freeMB}/${totMB} MB` +
      ` | Restarts: ${restartCount - 1}`
    );
  } catch (_) {}
}, MEM_LOG_MS).unref();

// ── Keep-alive self-ping (prevents Replit / free-hosting from sleeping) ───────
// TWO pings every cycle:
//  1. Localhost — keeps the local Express server warm
//  2. External Replit URL — the ONLY ping that actually prevents container sleep
//     (Replit ignores internal 127.0.0.1 traffic for sleep detection)
setInterval(() => {
  // Ping 1: localhost
  try {
    const req = http.get({
      hostname: '127.0.0.1',
      port    : PANEL_PORT,
      path    : '/api/status',
      timeout : 8000,
    }, (res) => res.resume());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
  } catch (_) {}

  // Ping 2: external public URL (critical on Replit)
  if (REPLIT_DOMAIN) {
    try {
      const req2 = https.get(
        `https://${REPLIT_DOMAIN}/api/status`,
        { timeout: 10000 },
        (res) => res.resume()
      );
      req2.on('error', () => {});
      req2.on('timeout', () => req2.destroy());
    } catch (_) {}
  }
}, KEEP_ALIVE_MS).unref();

// ── Crash-loop detector ───────────────────────────────────────────────────────
function isCrashLoop() {
  const now = Date.now();
  recentCrashes = recentCrashes.filter(t => now - t < CRASH_WINDOW_MS);
  recentCrashes.push(now);
  return recentCrashes.length >= CRASH_LOOP_THRESH;
}

// ── Exponential back-off delay ────────────────────────────────────────────────
function getDelay(attempt) {
  return Math.min(BASE_DELAY_MS * Math.pow(1.5, Math.max(0, attempt - 1)), MAX_DELAY_MS);
}

// ── Kill any stale process holding the panel port (prevents EADDRINUSE loops) ─
function freePort() {
  try {
    // SIGKILL whatever has port 5000 open so our child can bind cleanly
    require('child_process').execSync(
      `fuser -k ${PANEL_PORT}/tcp 2>/dev/null || true`,
      { timeout: 3000, stdio: 'ignore' }
    );
  } catch (_) {}
}

// ── Main launcher ─────────────────────────────────────────────────────────────
function launchBot() {
  restartCount++;
  const pendingFlag = path.join(__dirname, 'tmp', 'pending-install');   // written by .update / index.js when packages are missing
  const pending = fs.existsSync(pendingFlag);
  if (restartCount === 1) {
    console.log(`[WATCHDOG] 🧠 RAM limit ≈ ${LIMIT_MB} MB, heap cap ${HEAP_MB} MB`);
    ensureDependencies(pending);
    console.log('[WATCHDOG] 🚀 Launching bot...');
  } else {
    if (pending) ensureDependencies(true);          // bot is NOT running now → all RAM is free for npm
    console.log(`\n[WATCHDOG] 🔄 Restart #${restartCount - 1} — bot coming back up...\n`);
  }
  if (pending) { try { fs.unlinkSync(pendingFlag); } catch (_) {} }

  // Free port before every launch so EADDRINUSE is impossible
  freePort();

  child = spawn(process.execPath, [...NODE_FLAGS, 'index.js'], {
    stdio: 'inherit',
    env  : { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production', WATCHDOG: '1' },
    cwd  : __dirname,
  });

  child.on('exit', (code, signal) => {
    child = null;

    // ── Clean stop ──────────────────────────────────────────────────────────
    if (code === 0) {
      console.log('[WATCHDOG] ✅ Bot exited cleanly (exit 0). Watchdog stopping.');
      process.exit(0);
      return;
    }

    // ── Intentional restart (.restart command) ──────────────────────────────
    if (code === RESTART_EXIT_CODE) {
      console.log('[WATCHDOG] 🔁 Intentional restart — relaunching immediately...');
      recentCrashes = [];
      setImmediate(launchBot);
      return;
    }

    // ── Crash ───────────────────────────────────────────────────────────────
    const loop  = isCrashLoop();
    const delay = loop ? CRASH_LOOP_WAIT_MS : getDelay(restartCount);

    console.log(
      `\n[WATCHDOG] ⚠️  Crash (code=${code ?? 'null'}, signal=${signal ?? 'none'}).` +
      `${loop ? ' 🔥 Crash-loop detected!' : ''}` +
      ` Restarting in ${(delay / 1000).toFixed(0)}s...\n`
    );

    const t = setTimeout(launchBot, delay);
    t.unref?.();
  });

  child.on('error', (err) => {
    console.error('[WATCHDOG] ❌ Failed to spawn bot process:', err.message);
    child = null;
    const t = setTimeout(launchBot, BASE_DELAY_MS);
    t.unref?.();
  });
}

// ── Forward signals to child for graceful shutdown ────────────────────────────
function forwardSignal(sig) {
  if (child && !child.killed) {
    try { child.kill(sig); } catch (_) {}
  }
}

process.on('SIGTERM', () => {
  console.log('[WATCHDOG] 🛑 SIGTERM received — forwarding to bot...');
  forwardSignal('SIGTERM');
  setTimeout(() => process.exit(0), 8000);
});

process.on('SIGINT', () => {
  console.log('[WATCHDOG] 🛑 SIGINT received — forwarding to bot...');
  forwardSignal('SIGINT');
  setTimeout(() => process.exit(0), 5000);
});

// Watchdog must never crash — absorb all errors
process.on('uncaughtException',  (err) => console.error('[WATCHDOG] Uncaught exception:', err.message));
process.on('unhandledRejection', (r)   => console.error('[WATCHDOG] Unhandled rejection:', r?.message || r));

// ── Boot ──────────────────────────────────────────────────────────────────────
launchBot();
