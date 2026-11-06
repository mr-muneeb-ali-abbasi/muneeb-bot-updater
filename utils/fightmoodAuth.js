'use strict';
/**
 * Fight Mode — access code storage + verification
 *
 * Access code kabhi bhi plain text mein store nahi hoti — sirf ek salted
 * hash (scrypt) "data/fightmoodAuth.json" mein save hoti hai. Yeh file
 * source code nahi hai (runtime data hai), isliye GitHub update-repo mein
 * push karne se code leak nahi hoga — phir bhi behtar hai ke .gitignore
 * mein "data/fightmoodAuth.json" add kar dena.
 *
 * Kahin bhi (menu, help, error, log) asli code print NAHI hota — sirf
 * "set hai" / "set nahi hai" jaisa status dikhta hai.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const AUTH_FILE = path.join(__dirname, '..', 'data', 'fightmoodAuth.json');

function _load() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch (_) { return null; }
}

function _save(obj) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function hasCode() {
  const d = _load();
  return !!(d && d.hash && d.salt);
}

function setCode(plainCode) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plainCode), salt, 64).toString('hex');
  _save({ hash, salt, updatedAt: Date.now() });
}

function verifyCode(plainCode) {
  const d = _load();
  if (!d || !d.hash || !d.salt) return false;
  try {
    const hash = crypto.scryptSync(String(plainCode), d.salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(d.hash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

// ── Per-sender attempt limiting (3 galat koshish = 10 min lock) ───────────────
const _attempts = new Map(); // sender -> { count, lockUntil }
const MAX_ATTEMPTS = 3;
const LOCK_MS = 10 * 60 * 1000;

function isLocked(sender) {
  const a = _attempts.get(sender);
  if (!a) return false;
  if (a.lockUntil && Date.now() < a.lockUntil) return true;
  if (a.lockUntil && Date.now() >= a.lockUntil) { _attempts.delete(sender); return false; }
  return false;
}

function remainingLockMs(sender) {
  const a = _attempts.get(sender);
  if (!a || !a.lockUntil) return 0;
  return Math.max(0, a.lockUntil - Date.now());
}

function recordFailure(sender) {
  const a = _attempts.get(sender) || { count: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockUntil = Date.now() + LOCK_MS;
    a.count = 0;
  }
  _attempts.set(sender, a);
  return a;
}

function recordSuccess(sender) {
  _attempts.delete(sender);
}

module.exports = {
  hasCode, setCode, verifyCode,
  isLocked, remainingLockMs, recordFailure, recordSuccess,
  MAX_ATTEMPTS,
};
