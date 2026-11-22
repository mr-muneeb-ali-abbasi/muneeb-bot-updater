/**
 * .antigroupmentionstatus — NEW command (separate from .antigroupmention)
 *
 * Blocks WhatsApp "Group Status" posts and "X mentioned this group in a status"
 * notices. The post is ALWAYS deleted; then:
 *
 *   warn   (default) warning each time, user removed after <limit> warnings (default 2)
 *   delete           post is only deleted
 *   kick             post deleted + user removed immediately
 *
 * Short forms:  .agms   .antigms   .groupmentionstatus   .antigmstatus
 *
 * Group admins, bot owners and the panel's own bot accounts are never punished.
 * Logic lives in utils/antiGroupMentionStatus.js (hooked in handler.js).
 */

const database = require('../../database');
const agms     = require('../../utils/antiGroupMentionStatus');

const MODES = ['warn', 'delete', 'kick'];

const describe = (mode, limit) => {
  if (mode === 'delete') return 'Post sirf delete hogi (warning/kick nahi)';
  if (mode === 'kick')   return 'Post delete + user turant remove';
  return `Post delete + warning ⚠️ — ${limit} warnings par user remove 🚫`;
};

const cfg = (gs) => ({
  on:    !!gs.antigroupmentionstatus,
  mode:  MODES.includes((gs.antigroupmentionstatusMode || '').toLowerCase()) ? gs.antigroupmentionstatusMode.toLowerCase() : 'warn',
  limit: Math.min(10, Math.max(1, parseInt(gs.antigroupmentionstatusLimit, 10) || 2)),
});

function statusText(gs, botAdmin) {
  const c = cfg(gs);
  return (
    `🛡️ *Anti Group Mention Status*\n\n` +
    `Status : *${c.on ? '🟢 ON' : '🔴 OFF'}*\n` +
    `Mode   : *${c.mode}*\n${describe(c.mode, c.limit)}\n` +
    `Limit  : *${c.limit}* warning(s)\n` +
    `Bot admin : *${botAdmin === false ? '❌ NAHI (delete/remove nahi hoga)' : '✅ haan'}*\n\n` +
    `*Commands:*\n` +
    `• *.agms on* / *.agms off*\n` +
    `• *.agms set warn | delete | kick*\n` +
    `• *.agms limit <1-10>* — kitni warning ke baad remove\n` +
    `• *.agms reset* — sabki warnings saaf\n\n` +
    `_Short forms: .agms  .antigms  .groupmentionstatus_\n` +
    `_Admins aur bot owner par kuch nahi lagta._`
  );
}

module.exports = {
  name: 'antigroupmentionstatus',
  aliases: ['groupmentionstatus', 'agms', 'antigms', 'antigmstatus'],
  category: 'admin',
  description: 'Delete group-status posts / group mentions in status (warn, then remove)',
  usage: '.antigroupmentionstatus <on/off/set/limit/reset>',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: false,   // command works either way; we warn the admin if the bot is not admin

  async execute(sock, msg, args, extra) {
    try {
      const from = extra.from;
      const gs   = database.getGroupSettings(from);
      const opt  = (args[0] || '').toLowerCase();
      const c    = cfg(gs);

      if (!opt || opt === 'get' || opt === 'status' || opt === 'help') {
        return extra.reply(statusText(gs, extra.isBotAdmin));
      }

      const adminNote = extra.isBotAdmin === false
        ? `\n\n⚠️ *Bot is group ka admin nahi hai!* Delete aur remove ke liye bot ko admin banayein.` : '';

      if (opt === 'on') {
        database.updateGroupSettings(from, {
          antigroupmentionstatus: true,
          antigroupmentionstatusMode: c.mode,
          antigroupmentionstatusLimit: c.limit,
        });
        return extra.reply(`✅ *Anti Group Mention Status ON*\n\nMode: *${c.mode}*\n${describe(c.mode, c.limit)}${adminNote}`);
      }

      if (opt === 'off') {
        database.updateGroupSettings(from, { antigroupmentionstatus: false });
        return extra.reply('🔴 *Anti Group Mention Status OFF*');
      }

      if (opt === 'set') {
        const mode = (args[1] || '').toLowerCase();
        if (!MODES.includes(mode)) return extra.reply('❌ Mode chunein: *.agms set warn | delete | kick*');
        database.updateGroupSettings(from, { antigroupmentionstatus: true, antigroupmentionstatusMode: mode });
        return extra.reply(`✅ *Mode set: ${mode}*\n${describe(mode, c.limit)}\n\n(Anti Group Mention Status ab *ON* hai)${adminNote}`);
      }

      if (opt === 'limit') {
        const n = parseInt(args[1], 10);
        if (!Number.isInteger(n) || n < 1 || n > 10) return extra.reply('❌ Limit 1 se 10 ke beech likhein: *.agms limit 2*');
        database.updateGroupSettings(from, { antigroupmentionstatusLimit: n });
        return extra.reply(`✅ *Limit set: ${n}*\nUser ko *${n}* warning ke baad remove kiya jayega (mode *warn* mein).`);
      }

      if (opt === 'reset') {
        agms.resetGroup(from);
        return extra.reply('♻️ Is group ki saari group-status warnings saaf kar di gayi.');
      }

      return extra.reply(statusText(gs, extra.isBotAdmin));
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  },
};
