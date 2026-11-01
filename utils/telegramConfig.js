'use strict';
/**
 * utils/telegramConfig.js — Telegram Bot API token store (.tgsticker ke liye).
 * Priority: data/telegramToken.json (.settgtoken se set) → config.telegramBotToken → env TELEGRAM_BOT_TOKEN
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../data/telegramToken.json');

function getToken() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (d.token) return d.token;
  } catch (_) {}
  try { const config = require('../config'); if (config.telegramBotToken) return config.telegramBotToken; } catch (_) {}
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  return null;
}

function setToken(token) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ token: String(token || '').trim() }, null, 1));
    return true;
  } catch (_) { return false; }
}

module.exports = { getToken, setToken };
