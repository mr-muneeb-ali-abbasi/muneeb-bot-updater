'use strict';

/**
 * utils/caseFix.js — galat-case folders ko sahi naam par laata hai
 * ─────────────────────────────────────────────────────────────────────────
 * Linux par `Commands/` aur `commands/` alag folders hain. Bot ka code `./commands/...` aur `./Panel/...`
 * maangta hai. Agar kisi server par purane zip/backup se `Commands/` ya `panel/` ban gaya ho to:
 *   • sirf wahi folder (galat case) hoga  → us ka naam sahi kar deta hai
 *   • dono maujood honge                  → galat-case wale ki bachi hui files sahi folder mein merge karta hai
 *                                           (sahi folder ki files hamesha jeetti hain), phir galat folder hata deta hai
 *
 * Use: require('./caseFix').fixCase(botFolder)  →  ['Commands → commands (renamed)', ...]
 * Kabhi throw nahi karta.
 */

const fs   = require('fs');
const path = require('path');

// Sirf wahi folders jinka sahi naam code mein fixed hai (require('./commands/..'), require('./Panel/..'), ...)
const CANONICAL = ['commands', 'Panel', 'utils'];

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

function moveFile(src, dest) {
  try { fs.renameSync(src, dest); }
  catch (_) { fs.copyFileSync(src, dest); fs.unlinkSync(src); }       // alag disk (EXDEV) par rename nahi chalta
}

// src ki files dest mein daalo — jo dest mein pehle se hai use mat chhuo
function mergeDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dest, name);
    const lst = fs.lstatSync(s);
    if (lst.isDirectory()) {
      if (fs.existsSync(d) && isDir(d)) mergeDir(s, d);
      else if (!fs.existsSync(d)) { try { fs.renameSync(s, d); } catch (_) { mergeDir(s, d); } }
    } else if (!fs.existsSync(d)) {
      moveFile(s, d);
    }
  }
  fs.rmSync(src, { recursive: true, force: true });
}

function fixCase(root) {
  const done = [];
  let entries;
  try { entries = fs.readdirSync(root); } catch (_) { return done; }

  for (const canon of CANONICAL) {
    try {
      const wrong = entries.filter(n => n.toLowerCase() === canon.toLowerCase() && n !== canon && isDir(path.join(root, n)));
      if (!wrong.length) continue;
      const canonPath = path.join(root, canon);
      // Case-insensitive FS (Windows/mac): `canon` aur `wrong` ek hi folder hote hain — sirf naam badlo
      const sameFolder = fs.existsSync(canonPath) && !entries.includes(canon);
      for (const w of wrong) {
        const wPath = path.join(root, w);
        if (sameFolder) {
          const tmp = path.join(root, `.casefix_${Date.now()}`);
          fs.renameSync(wPath, tmp); fs.renameSync(tmp, canonPath);
          done.push(`${w} → ${canon} (renamed)`);
        } else if (!fs.existsSync(canonPath)) {
          fs.renameSync(wPath, canonPath);
          done.push(`${w} → ${canon} (renamed)`);
        } else {
          mergeDir(wPath, canonPath);
          done.push(`${w} → ${canon} (merged)`);
        }
      }
    } catch (e) { console.warn(`[caseFix] ${canon}:`, e.message); }
  }
  if (done.length) console.log('[caseFix]', done.join(' | '));
  return done;
}

module.exports = { fixCase };
