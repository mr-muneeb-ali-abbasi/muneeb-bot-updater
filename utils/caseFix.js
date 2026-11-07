'use strict';
/**
 * utils/caseFix.js — folder-name "case" auto-corrector
 * ─────────────────────────────────────────────────────────────────────────
 * Linux hosting me  Commands != commands  aur  panel != Panel.
 * Code in folder-names ko ye exact naam se dhundhta hai:
 *     commands/ (+ uske andar ke sub-folders, sab chhote)   utils/   Panel/
 * Agar repo / zip / upload me naam chhota-bada ho jaye to ye file unhe apne aap sahi kar deti hai
 * (startup par, .update ke time, aur command loader ko folder na mile tab).
 *
 * Kuch delete nahi karti — sirf rename / merge. Dono naam maujood hon to naye (latest mtime) wali file jeetti hai.
 */
const fs   = require('fs');
const path = require('path');

// lowercase naam  ->  sahi naam. 'panel' ka sahi naam code dekh kar tay hota hai (neeche detectPanelName)
const CANONICAL = {
  commands: 'commands',
  utils   : 'utils',
  panel   : null,
};
const SKIP_SCAN = new Set(['node_modules', 'sessions', 'session', 'data', 'tmp', 'temp', 'bin', '.git', '.cache', 'database']);
// In folders ke andar ke sub-folders ka naam hamesha lowercase hona chahiye
const LOWERCASE_CHILDREN = new Set(['commands']);

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// wrongPath ka content correctPath me merge karo (naya mtime jeete), phir wrongPath hata do
function mergeInto(wrongPath, correctPath) {
  fs.mkdirSync(correctPath, { recursive: true });
  for (const entry of fs.readdirSync(wrongPath)) {
    const from = path.join(wrongPath, entry);
    const to   = path.join(correctPath, entry);
    let toStat = null;
    try { toStat = fs.lstatSync(to); } catch {}
    const fromStat = fs.lstatSync(from);
    if (fromStat.isDirectory()) {
      if (toStat && toStat.isDirectory()) mergeInto(from, to);
      else if (!toStat) fs.renameSync(from, to);
      continue;
    }
    if (!toStat || fromStat.mtimeMs > toStat.mtimeMs) fs.copyFileSync(from, to);
  }
  fs.rmSync(wrongPath, { recursive: true, force: true });
}

// sirf case badalne wala rename (Windows/macOS ke liye 2-step)
function renameCase(parent, from, to, log) {
  const tmp = path.join(parent, `.__casefix_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  fs.renameSync(path.join(parent, from), tmp);
  fs.renameSync(tmp, path.join(parent, to));
  log.push(`${from} -> ${to}`);
}

function fixOne(parent, wrongName, rightName, log) {
  const names = fs.readdirSync(parent);
  const hasRight = names.includes(rightName);
  if (!hasRight) { renameCase(parent, wrongName, rightName, log); return; }
  // sahi naam wala folder pehle se hai -> merge (case-insensitive FS par ye branch nahi aati)
  mergeInto(path.join(parent, wrongName), path.join(parent, rightName));
  log.push(`${wrongName} merged into ${rightName}`);
}


// Poore code me dekho: require('./panel/server') zyada hai ya require('./Panel/server')
function countPanelRefs(dir, out, depth = 0) {
  if (depth > 6) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_SCAN.has(e.name)) continue;
      countPanelRefs(full, out, depth + 1);
    } else if (e.name.endsWith('.js')) {
      try {
        if (fs.statSync(full).size > 1_500_000) continue;
        const src = fs.readFileSync(full, 'utf8');
        const re = /['"`][^'"`\n]*\b(Panel|panel)\/(server|sessionManager|serverRegistry)\b/g;
        let m; while ((m = re.exec(src))) out[m[1]]++;
      } catch {}
    }
  }
  return out;
}

function detectPanelName(rootDir) {
  const c = countPanelRefs(rootDir, { Panel: 0, panel: 0 });
  const names = (() => { try { return fs.readdirSync(rootDir); } catch { return []; } })();
  let primary;
  if (c.Panel > c.panel) primary = 'Panel';
  else if (c.panel > c.Panel) primary = 'panel';
  else primary = names.includes('Panel') && !names.includes('panel') ? 'Panel' : 'panel';
  return { primary, other: primary === 'Panel' ? 'panel' : 'Panel', otherUsed: c[primary === 'Panel' ? 'panel' : 'Panel'] > 0 };
}

/**
 * @param {string} rootDir  project root (ya update ka extracted root)
 * @returns {string[]} kya kya badla (khali = sab theek tha)
 */
function fixCase(rootDir) {
  const log = [];
  let panel = null;
  try {
    panel = detectPanelName(rootDir);
    CANONICAL.panel = panel.primary;
    for (const name of fs.readdirSync(rootDir)) {
      const full = path.join(rootDir, name);
      const right = CANONICAL[name.toLowerCase()];
      let isLink = false; try { isLink = fs.lstatSync(full).isSymbolicLink(); } catch {}
      if (!right || name === right || isLink || !isDir(full)) continue;
      try { fixOne(rootDir, name, right, log); } catch (e) { log.push(`FAILED ${name}: ${e.message}`); }
    }
    for (const parentName of LOWERCASE_CHILDREN) {
      const parentDir = path.join(rootDir, CANONICAL[parentName]);
      if (!isDir(parentDir)) continue;
      for (const name of fs.readdirSync(parentDir)) {
        const lower = name.toLowerCase();
        if (name === lower || !isDir(path.join(parentDir, name))) continue;
        try { fixOne(parentDir, name, lower, log); } catch (e) { log.push(`FAILED ${parentName}/${name}: ${e.message}`); }
      }
    }
    // Code me dono naam (Panel/ aur panel/) use hote hon to doosre naam ka shortcut (symlink) bana do — dono chalenge
    if (panel && panel.otherUsed) {
      const names = fs.readdirSync(rootDir);
      if (names.includes(panel.primary) && !names.some(n => n.toLowerCase() === panel.other.toLowerCase() && n === panel.other)) {
        try { fs.symlinkSync(panel.primary, path.join(rootDir, panel.other), 'dir'); log.push(`alias ${panel.other} -> ${panel.primary}`); }
        catch (e) { if (e.code !== 'EEXIST') log.push(`alias FAILED: ${e.message}`); }
      }
    }
  } catch (e) { log.push(`FAILED: ${e.message}`); }
  if (log.length) console.log('[CaseFix] 🔧', log.join(' | '));
  return log;
}

module.exports = { fixCase };
