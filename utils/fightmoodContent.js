'use strict';
/**
 * Fight Mode — content library (file discovery + entry parsing)
 *
 * Owner is folder mein .txt files daalta hai (jaise "Birthday Wish 1.txt",
 * "Sorry Message 1.txt"). HAR FILE = EK POORA MESSAGE/WISH, jaisa ka taisa.
 *
 * FORMAT RULE (simple, zero confusion): jo bhi text file ke andar likha hai
 * — chahe kitni bhi lines ho, kitni bhi khaali lines ho, emojis, Urdu text,
 * stylish fonts, kuch bhi — poora wahi EK HI message ke roop mein, bilkul
 * jaisa likha hai waisa hi, ek saath bheja jaata hai. File ke andar koi
 * split/break kabhi nahi hota.
 *
 * Alag-alag wishes chahiye? To alag-alag FILES banao (jaise
 * "Birthday Wish 1.txt", "Birthday Wish 2.txt", "Sorry Message 1.txt" ...)
 * — har file apni poori list mein ek alag option ban kar aayegi.
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
 * Poori file ka text ek hi "entry" hai — KABHI bhi kisi bhi cheez (khaali
 * line, line-break, kuch bhi) par split nahi hota. Jo file ke andar likha
 * hai, poora wahi ek array mein (1 item) wapas jaata hai.
 */
function parseEntries(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  return [text];
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
