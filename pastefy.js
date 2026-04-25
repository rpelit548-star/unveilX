'use strict';

const { request } = require('undici');

/**
 * Sube contenido a Pastefy de forma anónima
 * @param {string} content - El código a subir
 * @param {string} title - Título del paste
 */
async function uploadToPastefy(content, title) {
  try {
    const res = await request('https://api.pastefy.app/v2/paste', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: title || 'Deobfuscated Code',
        content: content,
        visibility: 'public'
      })
    });

    const data = await res.body.json();

    if (res.statusCode >= 200 && res.statusCode < 300 && data.success) {
      return {
        ok: true,
        url: `https://pastefy.app/${data.paste.id}`,
        rawUrl: `https://pastefy.app/${data.paste.id}/raw`
      };
    } else {
      return { ok: false, error: data.message || 'Error en la API de Pastefy' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { uploadToPastefy };
