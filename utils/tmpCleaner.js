'use strict';
/**
 * Tmp Cleaner — asli masla fix karta hai (disk full → server offline)
 *
 * Jab bhi bot koi video/media WhatsApp par bhejta hai (jaise .facebook
 * downloader), WhatsApp ki Baileys library us file ko encrypt karne ke
 * liye system ke temp folder (os.tmpdir(), yani "/tmp") mein ek chhoti
 * si temporary file banati hai, upload hone ke baad usko khud delete
 * kar deti hai — LEKIN agar beech mein koi error/timeout/crash aa jaye
 * (jaisa bade video files ya slow server par hota hai), to wo temp file
 * wahin padi reh jaati hai. Dheere dheere yeh files jama hoti rehti hain
 * aur server ki disk bhar jaati hai → disk full → server offline ho
 * jaata hai.
 *
 * Do jagah saaf karta hai:
 *   1. os.tmpdir() — Baileys/axios/media-tools ke apne scratch files, sirf
 *      jaani-pehchani naam-pattern wali files (allow-list, poora /tmp khaali
 *      nahi karta).
 *   2. Project ke apne "tmp/" aur "temp/" folders (root mein) — yahan
 *      yt-dlp/downloader jo bhi save karta hai, woh poora dedicated scratch
 *      space hai (sirf isi cleaner ke liye), isliye yahan andar ki har purani
 *      file/khaali folder bina naam-check ke hata di jaati hai.
 *
 * Pehle: har 5 minute mein check, 10 minute se purani file hi orphan maanta
 * tha — matlab best case mein bhi ek file 10-15 minute tak padi reh sakti
 * thi. Ab: har 1 minute check, sirf 60 second purani file ko hi orphan
 * maanta hai — WhatsApp par file/video bhej dene ke chand second baad hi
 * disk se saaf ho jaati hai, bina kisi active send ko beech mein kaate.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TMP_DIR         = os.tmpdir();
const PROJECT_ROOT     = path.join(__dirname, '..');
const PROJECT_TMP_DIRS = [
  path.join(PROJECT_ROOT, 'tmp'),
  path.join(PROJECT_ROOT, 'temp'),
];

const STALE_MS       = 60 * 1000;   // 60 second se purani = orphan maan kar delete
const SWEEP_EVERY_MS = 60 * 1000;   // har 1 minute mein check karo

// Sirf un files/folders ko chhuo jo Baileys/axios/media-download tools
// banate hain — random-hex naam, ya known prefixes/extensions. System ki
// apni zaroori files (jaise .X11-unix, apt ki lock files, vagaira) ko
// kabhi mat chheडो — isliye ek allow-list pattern use kar rahe hain,
// pura /tmp khaali nahi kar rahe.
const SAFE_PATTERNS = [
  /^mdl_\d+_[a-z0-9]+\.mp4$/i,          // streamToFile() wali files
  /^[a-f0-9]{16,40}$/i,                  // Baileys ki random-hex temp files (no extension)
  /^[a-f0-9]{16,40}\.(enc|mp4|jpg|jpeg|png|webp|ogg|mp3|pdf|tmp)$/i,
  /^wa-sticker-.*\.webp$/i,
  /^baileys[-_].*/i,
  /^pair_tts_.*\.(mp3|ogg)$/i,           // Commands/general/pair.js ki TTS temp files
];

function isSafeToDelete(name) {
  return SAFE_PATTERNS.some((re) => re.test(name));
}

// ── Sweep #1: system temp dir — only known-safe name patterns ───────────────
function sweepSystemTmp() {
  let removed = 0;
  let freedBytes = 0;
  try {
    const entries = fs.readdirSync(TMP_DIR, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!isSafeToDelete(entry.name)) continue;

      const full = path.join(TMP_DIR, entry.name);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > STALE_MS) {
          freedBytes += stat.size;
          fs.unlinkSync(full);
          removed++;
        }
      } catch (_) { /* file already gone / no permission — ignore */ }
    }
  } catch (e) {
    console.log('[TmpCleaner] system-tmp sweep error:', e.message);
  }
  return { removed, freedBytes };
}

// ── Sweep #2: project's own dedicated tmp/temp folders — anything stale, ────
// no name-check needed since nothing except downloader scratch files should
// ever live here. Recurses into subfolders and removes empty dirs after.
function sweepDir(dir, now) {
  let removed = 0;
  let freedBytes = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return { removed, freedBytes }; } // dir doesn't exist — nothing to do

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const sub = sweepDir(full, now);
        removed += sub.removed;
        freedBytes += sub.freedBytes;
        // remove the subfolder itself if it's now empty
        try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch (_) {}
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > STALE_MS) {
          freedBytes += stat.size;
          fs.unlinkSync(full);
          removed++;
        }
      }
    } catch (_) { /* file/dir already gone mid-sweep, or no permission — ignore */ }
  }
  return { removed, freedBytes };
}

function sweepProjectTmpDirs() {
  let removed = 0;
  let freedBytes = 0;
  const now = Date.now();
  for (const dir of PROJECT_TMP_DIRS) {
    const r = sweepDir(dir, now);
    removed += r.removed;
    freedBytes += r.freedBytes;
  }
  return { removed, freedBytes };
}

function sweepOnce() {
  const a = sweepSystemTmp();
  const b = sweepProjectTmpDirs();
  const removed = a.removed + b.removed;
  const freedBytes = a.freedBytes + b.freedBytes;
  if (removed > 0) {
    const mb = (freedBytes / 1024 / 1024).toFixed(1);
    console.log(`[TmpCleaner] 🧹 Removed ${removed} orphaned temp file(s), freed ~${mb} MB`);
  }
  return { removed, freedBytes };
}

function start() {
  // Boot hote hi ek baar turant saaf karo (pichle crash ka leftover),
  // phir har SWEEP_EVERY_MS par dobara.
  sweepOnce();
  setInterval(sweepOnce, SWEEP_EVERY_MS).unref?.();
  console.log(`[TmpCleaner] ✅ Started — har ${SWEEP_EVERY_MS / 60000} min mein temp folder check hoga (${STALE_MS / 1000}s se purani file turant hatti hai)`);
}

module.exports = { start, sweepOnce };
