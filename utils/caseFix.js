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
 * Panel/Public/panel.html (admin panel /manage) bhi sahi jagah par laata hai: agar `Panel/public` (chhota p) aur
 * `Panel/Public` dono ho gaye hon (server.js `Public` ko pehle dekhta hai) to unhe merge karta hai, aur panel.html kisi
 * purani jagah par pada ho to `Panel/Public/` mein copy kar deta hai.
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

// ── Admin panel: Panel/Public/panel.html ("panel.html not found" ka ilaaj) ─────────────────────────────────────
// panel/server.js pehle `Public` dekhta hai, na ho tabhi `public`. Update ke baad agar `Public` ban gaya (zip se)
// par panel.html purane `public` mein reh gaya, to /manage "panel.html not found" deta hai.
function healPanelHtml(root, done) {
  try {
    const panelDir = path.join(root, 'Panel');
    if (!isDir(panelDir)) return;
    const pubUp = path.join(panelDir, 'Public'), pubLo = path.join(panelDir, 'public');
    const names = fs.readdirSync(panelDir);
    // dono ho gaye (Linux) → chhote `public` ko bade `Public` mein merge karo (Public ki files jeetti hain)
    if (names.includes('Public') && names.includes('public') && isDir(pubUp) && isDir(pubLo)) {
      mergeDir(pubLo, pubUp);
      done.push('Panel/public → Panel/Public (merged)');
    }
    const target = path.join(pubUp, 'panel.html');
    if (fs.existsSync(target)) return;
    // abhi bhi nahi mila → jaani-pehchani purani jagahon mein dhundo
    const candidates = [
      path.join(panelDir, 'public', 'panel.html'), path.join(panelDir, 'panel.html'),
      path.join(root, 'Public', 'panel.html'), path.join(root, 'public', 'panel.html'), path.join(root, 'panel.html'),
    ];
    const found = candidates.find(f => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } });
    if (found) {
      fs.mkdirSync(pubUp, { recursive: true });
      fs.copyFileSync(found, target);
      done.push(`panel.html ${path.relative(root, found)} → Panel/Public/panel.html (copied)`);
    } else {
      console.warn('[caseFix] ⚠️ panel.html kahin nahi mila — update repo mein Panel/Public/panel.html hona chahiye.');
    }
  } catch (e) { console.warn('[caseFix] panel.html:', e.message); }
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
  healPanelHtml(root, done);
  if (done.length) console.log('[caseFix]', done.join(' | '));
  return done;
}

module.exports = { fixCase };
