/**
 * Newsletter Command - Get newsletter information from WhatsApp channel link
 */

/**
 * Extract invite code from WhatsApp channel link
 * @param {string} link - Channel link (e.g., https://whatsapp.com/channel/0029VaAbCdEfGhIJkL)
 * @returns {string|null} - Invite code or null if invalid
 */
function getChannelInviteCode(link) {
  try {
    // Clean the link
    let cleanLink = link.trim();
    
    // Remove any query parameters or fragments
    cleanLink = cleanLink.split('?')[0].split('#')[0];
    
    // Try to parse as URL first
    try {
      const url = new URL(cleanLink);
      const parts = url.pathname.split('/').filter(Boolean);
      const code = parts[parts.length - 1];
      if (code && code.length > 0) {
        return code;
      }
    } catch (urlError) {
      // If URL parsing fails, try regex extraction
    }
    
    // Regex patterns to extract invite code
    const patterns = [
      /(?:whatsapp\.com|wa\.me)\/channel\/([A-Za-z0-9]+)/i,
      /\/channel\/([A-Za-z0-9]+)/i,
      /channel\/([A-Za-z0-9]+)/i
    ];
    
    for (const pattern of patterns) {
      const match = cleanLink.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    // If no pattern matches, check if the link itself is just the code
    if (/^[A-Za-z0-9]+$/.test(cleanLink)) {
      return cleanLink;
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting invite code:', error);
    return null;
  }
}


module.exports = {
  name: 'newsletter',
  aliases: ['channel', 'channelinfo', 'nl'],
  category: 'owner',
  description: 'Get newsletter information from WhatsApp channel link',
  usage: '.newsletter <channel link>',
  ownerOnly: true,
  superAdminOnly: true,
  async execute(sock, msg, args, extra) {
    try {
      const chatId = extra.from;
      
      // `.newsletter debug <link>` → shows how WhatsApp's raw reply was decoded (send a screenshot of it if a channel is still not read)
      if (String(args[0] || '').toLowerCase() === 'debug') {
        const dbg = {};
        try {
          const code = getChannelInviteCode(args.slice(1).join(' ') || '');
          if (!code) return extra.reply('Use: .newsletter debug <channel link>');
          const m = await require('../../utils/newsletterMeta').fetchChannelMeta(sock, code, { forceRaw: true, debug: dbg });
          return extra.reply(`🔎 *Debug*\n\n*Decoded:* ${m.name || '(no name)'} | ${m.id} | subs=${m.subscribers ?? '?'}\n\n*Raw reply:*\n${require('../../utils/newsletterMeta').describeRaw(dbg.raw)}`);
        } catch (e) {
          return extra.reply(`🔎 *Debug*\n\nError: ${e.message}\n\n*Raw reply:*\n${require('../../utils/newsletterMeta').describeRaw(dbg.raw)}`);
        }
      }

      // Get link from args or message text
      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text ||
                   args.join(' ');
      
      if (!text || text.trim().length === 0) {
        return extra.reply('❌ Please provide a WhatsApp channel link!\n\nExample: .newsletter https://whatsapp.com/channel/0029VaAbCdEfGhIJkL');
      }
      
      // Extract link from text (remove command prefix if present)
      let link = text.replace(/^\.(newsletter|nl|channel|channelinfo)\s+/i, '').trim() || args.join(' ').trim();
      
      // If no link provided, show error
      if (!link || link.length === 0) {
        return extra.reply('❌ Please provide a WhatsApp channel link!\n\nExample: .newsletter https://whatsapp.com/channel/0029VaAbCdEfGhIJkL');
      }
      
      // Try to extract invite code first (works with or without full URL)
      const inviteCode = getChannelInviteCode(link);
      
      if (!inviteCode) {
        return extra.reply('❌ Could not extract invite code from the link!\n\nPlease provide a valid WhatsApp channel link.\nExample: https://whatsapp.com/channel/0029VaAbCdEfGhIJkL\n\nOr just the invite code: .newsletter 0029VaAbCdEfGhIJkL');
      }
      
      // Use the extracted invite code directly
      link = inviteCode;
      
     
      
      try {
        const { fetchChannelMeta } = require('../../utils/newsletterMeta');
        const m = await fetchChannelMeta(sock, link);

        let infoText = `📣 *${m.name || 'Channel'}*${m.verified ? ' ✅' : ''}\n\n`;
        infoText += `🆔 *JID:* ${m.id}\n`;
        if (m.description) infoText += `📝 *Description:* ${m.description}\n`;
        if (m.invite) infoText += `🔗 *Invite Code:* \`${m.invite}\`\n`;
        if (m.subscribers != null) infoText += `👥 *Subscribers:* ${m.subscribers.toLocaleString()}\n`;
        if (m.created) infoText += `📅 *Created:* ${new Date(m.created * 1000).toLocaleDateString()}\n`;
        if (m.state) infoText += `📌 *State:* ${m.state}\n`;

        if (m.pictureUrl) {
          try {
            await sock.sendMessage(chatId, { image: { url: m.pictureUrl }, caption: infoText }, { quoted: msg });
            return;
          } catch (_) { /* picture not downloadable → send text only */ }
        }
        await sock.sendMessage(chatId, { text: infoText }, { quoted: msg });

      } catch (error) {
        console.error('Newsletter command error:', error);
        
        if (error.message.includes('Invalid channel link')) {
          await extra.reply('❌ Invalid channel link format!\n\nPlease provide a valid WhatsApp channel link.\nExample: https://whatsapp.com/channel/0029VaAbCdEfGhIJkL');
        } else if (error.message.includes('Newsletter not found')) {
          await extra.reply('❌ Newsletter not found!\n\nThe channel link might be invalid or the newsletter might not exist.');
        } else if (error.message.includes('newsletterMetadata')) {
          await extra.reply('❌ Newsletter feature not available!\n\nMake sure you are using Baileys v7.0.0-rc or higher.');
        } else {
          await extra.reply(`❌ Failed to get newsletter information: ${error.message}`);
        }
      }
      
    } catch (error) {
      console.error('Newsletter command error:', error);
      await extra.reply(`❌ An error occurred: ${error.message}`);
    }
  }
};

