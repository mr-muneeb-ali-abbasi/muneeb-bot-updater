'use strict';

/**
 * utils/localVersion.js — bot ka LOCAL version (jo abhi server par chal raha hai)
 * ─────────────────────────────────────────────────────────────────────────
 * Source of truth : <bot folder>/version.json   (update zip yahi file naya karke deti hai)
 * Fallback        : package.json "version"      (agar version.json abhi server par nahi hai)
 *
 * Har baar disk se padhta hai (require cache use nahi karta), isliye update ke baad
 * naya version turant dikhta hai.
 *
 * Use: require('./localVersion').getLocalVersion()  →  { version: '1.5.6', releaseDate: '...', source: 'version.json' }
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readJson(file) {
  try {
    return JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (_) { return null; }
}

function getLocalVersion() {
  const v = readJson(path.join(ROOT, 'version.json'));
  if (v && v.version) {
    return { version: String(v.version), releaseDate: v.releaseDate || v.date || null, source: 'version.json' };
  }
  const p = readJson(path.join(ROOT, 'package.json'));
  if (p && p.version) {
    return { version: String(p.version), releaseDate: p.releaseDate || null, source: 'package.json' };
  }
  return { version: '1.0.0', releaseDate: null, source: 'default' };
}

module.exports = { getLocalVersion };
