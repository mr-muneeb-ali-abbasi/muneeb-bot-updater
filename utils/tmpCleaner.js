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
 * jaata hai (OptikLink jaisi choti disk wali hosting par yeh jaldi hota
 * hai, Amazon jaisi badi disk wali hosting par kam dikhta hai isiliye
 * wahan file nazar nahi aayi — masla wahan bhi ho raha hai, bas disk
 * bhadi hai to time zyada lagta hai).
 *
 * Yeh file har kuch minute mein temp folder check karke purani
 * (stale) chhod di gayi files khud-ba-khud delete kar deti hai, taaki
 * disk kabhi bharne na paye — original media messages (jo turant
 * upload ho jaati hain) ko yeh kabhi nahi chhedta, sirf un files ko
 * jo kaafi der (10+ min) se padi hain, matlab definitely orphaned hain.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TMP_DIR       = os.tmpdir();
const STALE_MS       = 10 * 60 * 1000;   // 10 minute se purani = orphan maan kar delete
const SWEEP_EVERY_MS = 5 * 60 * 1000;    // har 5 minute mein check karo

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
];

function isSafeToDelete(name) {
  return SAFE_PATTERNS.some((re) => re.test(name));
}

function sweepOnce() {
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
    console.log('[TmpCleaner] sweep error:', e.message);
  }
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
  setInterval(sweepOnce, SWEEP_EVERY_MS);
  console.log(`[TmpCleaner] ✅ Started — har ${SWEEP_EVERY_MS / 60000} min mein temp folder check hoga`);
}

module.exports = { start, sweepOnce };
