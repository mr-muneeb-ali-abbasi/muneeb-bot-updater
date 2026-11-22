/**
 * Delete Command
 * Delete a replied message  —  normal message AUR Group Status post dono.
 *
 *   .delete          reply karke → message delete (group status ho to khud pehchan leta hai)
 *   .delete status   reply karke → group-status ke tareeqe se zabardasti delete (agar auto-pehchan na ho paye)
 *   Short forms: .del   .del status   .del gs
 *
 * NOTE: `botAdminNeeded: true` — bot group mein ADMIN na ho to handler.js command ko execute() tak
 * pahunchne hi nahi deta. Delete sirf tab hota hai jab bot admin ho (WhatsApp ki apni requirement).
 *
 * GROUP STATUS ka asli masla (research ke baad):
 *   Group status (groupStatusMessageV2) par admin ka delete tabhi lagta hai jab revoke stanza mein
 *   <meta is_group_status="true"/> node ho. Baileys ka normal `sock.sendMessage({ delete })` wo node
 *   nahi lagata — isliye normal message delete hota tha, status nahi. Ab group-status par hum
 *   utils/groupStatusRevoke.js se wo node ke saath admin-revoke bhejte hain (plus normal delete bhi).
 *   Bot ko group status khud nahi dikhta (Baileys use drop karta hai) — post tabhi milta hai jab uspar
 *   reply karo; reply ke contextInfo se post ka key aa jata hai.
 *   Har attempt console mein [DELETE] / [GS-REVOKE] lines ke saath log hota hai.
 */

const { classify, deleteGroupMessage } = require('../../utils/groupStatusRevoke');

const FORCE = new Set(['status', 'gs', 'groupstatus', 's']);

module.exports = {
  name: 'delete',
  aliases: ['del'],
  description: 'Delete a replied message (works on Group Status posts too)',
  usage: '.delete (reply to a message) | .delete status (reply to a group status)',
  category: 'admin',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      // reply kisi bhi message type ke saath ho sakta hai (text, image, sticker...) — contextInfo dhoondo
      const m = msg.message || {};
      const holder = m.extendedTextMessage || Object.values(m).find((v) => v && typeof v === 'object' && v.contextInfo);
      const ctx = holder?.contextInfo;

      if (!ctx?.stanzaId) {
        return extra.reply('🗑️ Reply to the message you want to delete.\n_Group status delete karne ke liye bhi uspar reply karke *.delete* likho._');
      }

      const forms = [...new Set([ctx.participant, ctx.participantPn, ctx.participantAlt].filter(Boolean))];
      const force = FORCE.has(String(args?.[0] || '').toLowerCase());
      const kind  = classify(ctx.quotedMessage);

      console.log(`[DELETE] target=${ctx.stanzaId} kind=${kind || 'normal'}${force ? ' (forced status)' : ''} ` +
        `participants=[${forms.map((f) => String(f).split('@')[0]).join(', ')}] ` +
        `quotedKeys=[${Object.keys(ctx.quotedMessage || {}).join(', ')}]`);

      const res = await deleteGroupMessage(sock, extra.from, ctx.stanzaId, forms, { kind, forceStatus: force });
      for (const s of res.steps) console.log(`[DELETE]   ${s}`);

      if (!res.ok) {
        console.error('Delete command error (all attempts failed):', res.lastErr?.message || res.lastErr);
        return extra.reply(`❌ Failed to delete message${res.lastErr ? ': ' + res.lastErr.message : ''}.\n\n_Check karo ke bot is group mein ADMIN hai._`);
      }
    } catch (error) {
      console.error('Delete command error:', error);
      await extra.reply('❌ Failed to delete message.');
    }
  },
};
