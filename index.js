'use strict';

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const { request } = require('undici');
const { deobfuscate } = require('./deobfuscator');
const { uploadToPastefy } = require('./pastefy');

const PREFIX = '.l';
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.error('[FATAL] DISCORD_TOKEN env var is required.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

const GREEN = 0x2ecc71;
const GRAY = 0x95a5a6;
const RED = 0xe74c3c;

const STATUS_LABEL = { good: 'Good', medium: 'Medium', bad: 'Bad' };

function formatTime(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function firstNLines(text, n) {
  const lines = text.split('\n');
  if (lines.length <= n) return text;
  return lines.slice(0, n).join('\n');
}

async function fetchUrlContent(url) {
  const res = await request(url, { maxRedirections: 5 });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode} fetching URL`);
  }
  return await res.body.text();
}

async function getInputFromMessage(message, args) {
  if (message.attachments && message.attachments.size > 0) {
    const att = message.attachments.first();
    const res = await request(att.url);
    return await res.body.text();
  }
  if (args.length > 0) {
    const candidate = args.join(' ').trim();
    if (/^https?:\/\//i.test(candidate)) {
      return await fetchUrlContent(candidate);
    }
    let cleaned = candidate;
    cleaned = cleaned.replace(/^```(?:lua|luau)?\s*\n?/i, '').replace(/\s*```$/, '');
    return cleaned;
  }
  return null;
}

async function handleDeobfuscate(message, args) {
  const startedAt = Date.now();
  let typingTimer;
  try {
    if (typeof message.channel.sendTyping === 'function') {
      await message.channel.sendTyping().catch(() => {});
      typingTimer = setInterval(
        () => message.channel.sendTyping().catch(() => {}),
        8000
      );
    }

    const input = await getInputFromMessage(message, args);
    if (!input || input.trim().length === 0) {
      const errEmbed = new EmbedBuilder()
        .setColor(RED)
        .setTitle('Dump failed')
        .setDescription('No input provided. Attach a file, paste code, or pass a URL after `.l`.');
      await message.reply({ embeds: [errEmbed] });
      return;
    }

    const result = deobfuscate(input, { format: true });

    if (!result.success) {
      const errEmbed = new EmbedBuilder()
        .setColor(RED)
        .setTitle('Dump failed')
        .addFields(
          { name: 'Error', value: '```' + (result.error || 'unknown').slice(0, 1000) + '```' },
          { name: 'Time', value: formatTime(result.timeMs || (Date.now() - startedAt)), inline: true }
        );
      await message.reply({ embeds: [errEmbed] });
      return;
    }

    const code = result.code || '';
    const analysis = result.analysis || { techniques: [], weakPoints: [], status: 'bad' };

    const fileBuffer = Buffer.from(code, 'utf8');
    const attachment = new AttachmentBuilder(fileBuffer, { name: 'code.txt' });

    const paste = await uploadToPastefy(code, `deobfuscated-${Date.now()}`);

    const greenEmbed = new EmbedBuilder()
      .setColor(GREEN)
      .setTitle('Dump successfully')
      .addFields(
        {
          name: 'Time',
          value: formatTime(result.timeMs),
          inline: true
        },
        {
          name: 'Status',
          value: STATUS_LABEL[analysis.status] || 'Unknown',
          inline: true
        },
        {
          name: 'Techniques',
          value: (analysis.techniques.slice(0, 10).map(t => `• ${t}`).join('\n')) || 'None detected'
        },
        {
          name: 'Weak point',
          value: (analysis.weakPoints.slice(0, 6).map(w => `• ${w}`).join('\n')) || 'None'
        }
      );

    const components = [];
    if (paste.ok) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Open link')
          .setURL(paste.rawUrl)
      );
      components.push(row);
    } else {
      greenEmbed.addFields({
        name: 'Open link',
        value: `Pastefy upload failed: ${paste.error || 'unknown'}`
      });
    }

    const preview = firstNLines(code, 3);
    const grayEmbed = new EmbedBuilder()
      .setColor(GRAY)
      .setDescription('```lua\n' + preview.slice(0, 3800) + '\n```');

    await message.reply({
      embeds: [greenEmbed, grayEmbed],
      files: [attachment],
      components
    });
  } catch (err) {
    console.error('[ERROR]', err);
    const errEmbed = new EmbedBuilder()
      .setColor(RED)
      .setTitle('Dump failed')
      .setDescription('```' + (err.message || String(err)).slice(0, 1500) + '```');
    await message.reply({ embeds: [errEmbed] }).catch(() => {});
  } finally {
    if (typingTimer) clearInterval(typingTimer);
  }
}

client.once('clientReady', () => {
  console.log(`[READY] Logged in as ${client.user.tag}`);
  client.user.setActivity('.l <code|file|url>', { type: 0 });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content = message.content || '';
  const trimmed = content.trimStart();
  if (!trimmed.toLowerCase().startsWith(PREFIX)) return;
  const after = trimmed.slice(PREFIX.length);
  if (after.length > 0 && !/^\s/.test(after)) return;
  const args = after.trim().length > 0 ? after.trim().split(/\s+/) : [];
  await handleDeobfuscate(message, args);
});

client.on('error', (err) => console.error('[CLIENT ERROR]', err));
process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));

client.login(TOKEN).catch((err) => {
  console.error('[LOGIN FAILED]', err);
  process.exit(1);
});
