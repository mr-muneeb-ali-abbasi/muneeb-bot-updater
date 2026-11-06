'use strict';
/**
 * Fight Mode — content library (file discovery + entry parsing)
 *
 * Owner is folder mein .txt files daalta hai (jaise "Birthday Wishes.txt",
 * "Sorry Messages.txt"). Har file mein KAI ALAG-ALAG messages ho sakte hain.
 *
 * FORMAT RULE (hamesha yehi follow karo, taaki koi wish kabhi beech mein na
 * toote): har message/wish ke beech EK KHAALI LINE chhodo — chaahe wish ek
 * line ki ho ya kayi lines ki (emojis, line-breaks sab apni jagah rehte
 * hain, kuch trim nahi hota). Do khaali-line-separated blocks ke beech ka
 * poora text EK hi entry maana jaata hai — isiliye lambi, multi-line wish
 * kabhi automatically split nahi hoti.
 *
 * Example file content:
 *   Happy Birthday!
 *   Wishing you joy 🎉
 *
 *   May this year bring you
 *   endless happiness and success.
 *
 * (upar do alag entries hain, dono apni poori multi-line form mein safe hain)
 *
 * Koi bhi file add/remove karne par code change karne ki zaroorat nahi —
 * yeh folder ko har baar fresh scan karta hai.
 */

const fs   = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, '..', 'data', 'fightmood-content');

function ensureDir() {
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
}

function prettyName(filename) {
  return filename.replace(/\.txt$/i, '').replace(/[_-]+/g, ' ').trim();
}

/**
 * Entries ek file se nikalta hai — SIRF khaali-line par split karta hai,
 * kabhi bhi single "\n" (ek-line-break) par nahi. Isse ek multi-line wish
 * kabhi do alag entries mein nahi toot sakti; agar file mein koi khaali
 * line hi nahi hai, to poori file EK hi entry maani jaati hai (safe
 * default — galti se split hone se behtar hai sab ek sath rakhna).
 */
function parseEntries(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  return text.split(/\n[ \t]*\n+/).map(b => b.trim()).filter(Boolean);
}

function listFiles() {
  ensureDir();
  const files = fs.readdirSync(CONTENT_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && /\.txt$/i.test(e.name))
    .map(e => {
      const full = path.join(CONTENT_DIR, e.name);
      let entries = [];
      let sizeBytes = 0;
      try {
        const raw = fs.readFileSync(full, 'utf8');
        entries = parseEntries(raw);
        sizeBytes = fs.statSync(full).size;
      } catch (_) {}
      return {
        filename: e.name,
        displayName: prettyName(e.name),
        entryCount: entries.length,
        sizeKb: +(sizeBytes / 1024).toFixed(1),
      };
    })
    .filter(f => f.entryCount > 0)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return files;
}

function readFileEntries(filename) {
  ensureDir();
  const full = path.join(CONTENT_DIR, filename);
  if (!fs.existsSync(full)) return [];
  try {
    return parseEntries(fs.readFileSync(full, 'utf8'));
  } catch (_) { return []; }
}

/** Fisher-Yates shuffle ek copy par (original array nahi badalta) */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** N DISTINCT entries select karta hai (kabhi duplicate nahi, jitne available hain usse zyada nahi) */
function pickEntries(filename, quantity) {
  const all = readFileEntries(filename);
  const capped = Math.min(quantity, all.length);
  const picked = shuffle(all).slice(0, capped);
  return { picked, available: all.length, capped };
}

module.exports = { CONTENT_DIR, ensureDir, listFiles, readFileEntries, pickEntries, prettyName };
