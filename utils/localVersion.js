'use strict';
/**
 * utils/localVersion.js — bot ka ASLI local version (ek hi jagah se, sab commands yahi use karein)
 * version.json (repo ka release version) aur package.json dono padhta hai, jo BADA ho wahi deta hai.
 * Is tarah package.json bump karna bhool bhi jao to .update / .menu / .checkupdate sahi version dikhayenge.
 */
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readJson(file) {
  try { return JSON.parse(String(fs.readFileSync(path.join(ROOT, file), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (_) { return null; }
}

function parse(v) { return String(v || '0').replace(/[^0-9.]/g, '').split('.').map(n => parseInt(n, 10) || 0); }
function gt(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** @returns {{version:string, releaseDate:(string|null)}} — hamesha fresh disk se (require cache nahi) */
function getLocalVersion() {
  const vj = readJson('version.json');
  const pj = readJson('package.json');
  const vV = vj && vj.version ? String(vj.version) : null;
  const pV = pj && pj.version ? String(pj.version) : null;
  let version = vV || pV || '1.0.0';
  if (vV && pV && gt(pV, vV)) version = pV;
  return { version, releaseDate: (vj && (vj.releaseDate || vj.date)) || (pj && pj.releaseDate) || null };
}

module.exports = { getLocalVersion };
