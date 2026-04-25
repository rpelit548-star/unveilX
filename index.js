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
const http = require('http'); 
const { deobfuscate } = require('./deobfuscator'); 
const { uploadToPastefy } = require('./pastefy');

const PREFIX = '.l';
const TOKEN = process.env.DISCORD_TOKEN;

// Se establece el puerto 3000 explícitamente para Railway
const PORT = process.env.PORT || 3000; 

// --- SERVIDOR WEB DE SALUD PARA RAILWAY ---
// Este servidor responde a Railway para confirmar que la app está viva
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('UnveilX Bot is Online\n');
}).listen(PORT, () => {
  console.log(`[WEB] Servidor escuchando en puerto ${PORT}`);
});

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

const STATUS_LABEL = { good: 'Bueno', medium: 'Medio', bad: 'Malo' };

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
  // Manejo de archivos adjuntos
  if (message.attachments && message.attachments.size > 0) {
    const att = message.attachments.first();
    const res = await request(att.url);
    return await res.body.text();
  }
  // Manejo de URLs o código directo
  if (args.length > 0) {
    const candidate = args.join(' ').trim();
    if (/^https?:\/\//i.test(candidate)) {
      return await fetchUrlContent(candidate);
    }
    let cleaned = candidate;
    cleaned = cleaned.replace(/^
