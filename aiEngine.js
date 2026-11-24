'use strict';
/**
 * Root aiEngine.js — kept ONLY because utils/respectGuard.js requires('../aiEngine').
 * The old v6 "12-API" engine (dead free APIs, hard-coded model names) was removed: everything now goes through
 * utils/aiEngine.js (keys from `.aikey`, live model discovery). Do not add API logic here.
 */
module.exports = require('./utils/aiEngine');
