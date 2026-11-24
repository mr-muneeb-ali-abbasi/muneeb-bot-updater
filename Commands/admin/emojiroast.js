'use strict';
// .emojiroast lives in owner/emojiroast.js (per-bot switch, newer logic). This old admin copy had the same name + aliases,
// so the loader silently kept only one of them. One implementation now — same pattern as fun/save.js → owner/save.js.
module.exports = require('../owner/emojiroast');
