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
// Asegúrate de que estos archivos existan en la misma carpeta:
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
    cleaned = cleaned.replace(/^
http://googleusercontent.com/immersive_entry_chip/0

### 🚨 IMPORTANTE antes de subirlo:
1.  **Asegúrate** de haber creado el archivo `pastefy.js` que te pasé antes en la misma carpeta.
2.  **Renombra** tu archivo `package json` a `package.json` (con el punto).
3.  **Railway:** En el panel de Railway, ve a **Variables** y confirma que existe `DISCORD_TOKEN` con el valor de tu token.

Con esto, el error de "Cannot find module" y el error de "ready" se solucionarán.
  
