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

// lowercase naam  ->  sahi naam (jo code me likha hai)
const CANONICAL = {
  commands: 'commands',
  utils   : 'utils',
  panel   : 'Panel',
};
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

/**
 * @param {string} rootDir  project root (ya update ka extracted root)
 * @returns {string[]} kya kya badla (khali = sab theek tha)
 */
function fixCase(rootDir) {
  const log = [];
  try {
    for (const name of fs.readdirSync(rootDir)) {
      const full = path.join(rootDir, name);
      const right = CANONICAL[name.toLowerCase()];
      if (!right || name === right || !isDir(full)) continue;
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
  } catch (e) { log.push(`FAILED: ${e.message}`); }
  if (log.length) console.log('[CaseFix] 🔧', log.join(' | '));
  return log;
}

module.exports = { fixCase };
