'use strict';
/**
 * utils/ownerBind.js — super-owner number ko poore bot me ek jagah se chalata hai.
 * ─────────────────────────────────────────────────────────────────────────
 * Bot ki kai files me purana owner number seedha likha hua hai (handler.js, Commands/lib/*, kick, strictguard ...).
 * Ye file bot start hote hi (node --require se, startup.js lagata hai) har project file ke load hone se
 * pehle uska text dekhti hai aur purane number ki jagah utils/ownerConfig.js wala number laga deti hai.
 *
 *  • Disk par koi file nahi badalti  → .update / .restart / hot-reload ke baad bhi apne aap lagta rehta hai
 *  • Agar number wahi hai jo pehle tha (abhi hai) → kuch bhi nahi karti, bot bilkul pehle jaisa chalta hai
 *  • Sirf digits ki jagah digits lagte hain → code toot nahi sakta
 */
const Module = require('module');
const path   = require('path');

const LEGACY = '923196615238';                       // jo number purani files me seedha likha hai
const ROOT   = path.resolve(__dirname, '..');
const SKIP_TOP = new Set(['node_modules', 'sessions', 'session', 'data', 'tmp', 'temp', 'bin', '.git']);
const SKIP_FILES = new Set(['config.js', 'utils/ownerConfig.js', 'utils/ownerBind.js']);   // config.js: har server ka apna
const RE = new RegExp('(?<!\\d)' + LEGACY + '(?!\\d)', 'g');

function transform(content, filename, mainDev) {
  if (typeof content !== 'string' || !content.includes(LEGACY)) return content;
  if (!filename.startsWith(ROOT + path.sep)) return content;
  const rel = path.relative(ROOT, filename).split(path.sep);
  if (SKIP_TOP.has(rel[0]) || rel.includes('node_modules') || SKIP_FILES.has(rel.join('/'))) return content;
  return content.replace(RE, mainDev);
}

let MAIN = LEGACY;
try { MAIN = require('./ownerConfig').MAIN_DEV; } catch (_) {}

if (MAIN && MAIN !== LEGACY && /^\d{8,15}$/.test(MAIN)) {
  const orig = Module.prototype._compile;
  Module.prototype._compile = function (content, filename) {
    try { content = transform(content, filename, MAIN); } catch (_) {}
    return orig.call(this, content, filename);
  };
  console.log(`[OwnerBind] ✅ super owner = ${MAIN} (ownerConfig se)`);
}

module.exports = { transform, LEGACY, MAIN };
