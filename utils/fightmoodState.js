'use strict';
/**
 * Fight Mode — bot-wide on/off switch (owner kill-switch).
 * Default: ON. Owner ".fightmood off" se turant band kar sakta hai.
 */

const fs   = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'fightmoodState.json');

function _load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { enabled: true };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) { return { enabled: true }; }
}

function _save(obj) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function isEnabled() {
  return _load().enabled !== false;
}

function setEnabled(val) {
  _save({ enabled: !!val, updatedAt: Date.now() });
}

module.exports = { isEnabled, setEnabled };
