'use strict';
/**
 * utils/ownerConfig.js — SUPER OWNER (main developer) ka number: sirf EK jagah.
 * ─────────────────────────────────────────────────────────────────────────
 * Priority (upar wala jeetta hai):
 *   1. config.js  →  mainDeveloper: '923xxxxxxxxx'      (sirf us ek server ke liye)
 *   2. env variable MAIN_DEVELOPER                       (sirf us ek server ke liye)
 *   3. DEFAULT_MAIN_DEV neeche                           (repo me — .update se SAARE servers par)
 *
 * Number hamesha sirf digits me likho: bina +, bina space, bina dash.
 * Badalne ke baad bot ko poora RESTART karna zaroori hai (panel wala RESTART button).
 */
const DEFAULT_MAIN_DEV = '923196615238';     // ← saare servers ka super owner yahan se (abhi wahi purana number)

const digits = (v) => String(Array.isArray(v) ? v[0] : (v || '')).replace(/[^0-9]/g, '');
const valid  = (v) => /^\d{8,15}$/.test(v);

function resolveMainDev() {
  let cfg = {};
  try { cfg = require('../config'); } catch (_) {}
  for (const v of [digits(cfg && cfg.mainDeveloper), digits(process.env.MAIN_DEVELOPER), DEFAULT_MAIN_DEV]) {
    if (valid(v)) return v;
  }
  return DEFAULT_MAIN_DEV;
}

module.exports = { MAIN_DEV: resolveMainDev(), DEFAULT_MAIN_DEV, resolveMainDev };
