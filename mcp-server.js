#!/usr/bin/env node
'use strict';
/*
 * Claude Robot — MCP sunucusu (stdio)
 *
 * Bağımlılık yok: JSON-RPC 2.0 mesajlarını doğrudan stdin/stdout üzerinden
 * konuşur. Aldığı çağrıları widget'ın yerel kontrol sunucusuna iletir.
 *
 * Kurulum:
 *   claude mcp add robot -- node "<bu dosyanın tam yolu>"
 */

const http = require('http');

const PORT = Number(process.env.CLAUDE_ROBOT_PORT) || 47821;
const HOST = '127.0.0.1';
const PROTOCOL_VERSION = '2024-11-05';

const VALID_STATES = ['idle', 'thinking', 'working', 'writing', 'waiting', 'success', 'error'];
const VALID_THEMES = ['neon', 'silver', 'blue', 'red', 'pastel'];

/* --------------------------------------------------------- widget'a istek */

function call(method, path, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        timeout: 2000,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch { resolve({ ok: false, error: 'widget geçersiz yanıt döndü' }); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); });
    req.on('error', () => {
      resolve({ ok: false, error: `Robot widget çalışmıyor (${HOST}:${PORT}). "npm start" ile başlat.` });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------------ araçlar */

const TOOLS = [
  {
    name: 'robot_set_state',
    description:
      'Masaüstündeki robot avatarının durumunu değiştirir. Düşünürken "thinking", okuma/komut ' +
      'gibi bir iş yaparken "working", dosyaya kod yazarken "writing", kullanıcıdan girdi ' +
      'beklerken "waiting", iş bitince "success", gerçek bir başarısızlıkta "error", boştayken ' +
      '"idle" kullan.',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: VALID_STATES,
          description: 'Yeni durum.'
        },
        text: {
          type: 'string',
          description: 'Göğüs ekranında gösterilecek kısa yazı (en fazla ~11 karakter görünür), örn. "BUILD" veya "TESTS".'
        },
        durationMs: {
          type: 'number',
          description: 'Bu süre sonunda otomatik olarak revertTo durumuna döner (ms).'
        },
        revertTo: {
          type: 'string',
          enum: VALID_STATES,
          description: 'durationMs dolunca dönülecek durum. Varsayılan: idle.'
        }
      },
      required: ['state']
    }
  },
  {
    name: 'robot_get_state',
    description: 'Robotun o anki durumunu, ekran yazısını ve temasını döndürür.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'robot_set_theme',
    description: 'Robotun renk temasını değiştirir ve kalıcı olarak kaydeder.',
    inputSchema: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: VALID_THEMES, description: 'Renk teması.' }
      },
      required: ['theme']
    }
  }
];

async function runTool(name, args) {
  args = args || {};

  if (name === 'robot_set_state') {
    if (!VALID_STATES.includes(args.state)) {
      return `Geçersiz durum "${args.state}". Geçerli olanlar: ${VALID_STATES.join(', ')}`;
    }
    const r = await call('POST', '/state', {
      state: args.state,
      text: args.text,
      durationMs: args.durationMs,
      revertTo: args.revertTo
    });
    return r.ok
      ? `Robot durumu: ${r.state}${r.text ? ` ("${r.text}")` : ''}`
      : `Hata: ${r.error}`;
  }

  if (name === 'robot_get_state') {
    const r = await call('GET', '/state');
    return r.ok
      ? `durum=${r.state} yazı=${r.text || '-'} tema=${r.theme} boyut=${r.size}px`
      : `Hata: ${r.error}`;
  }

  if (name === 'robot_set_theme') {
    const r = await call('POST', '/theme', { theme: args.theme });
    return r.ok ? `Tema değişti: ${r.theme}` : `Hata: ${r.error}`;
  }

  return `Bilinmeyen araç: ${name}`;
}

/* -------------------------------------------------------------- JSON-RPC */

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  // Bildirimlerin (id'siz mesajlar) yanıtı olmaz.
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-robot', version: '1.0.0' }
      });

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params && params.name;
      try {
        const text = await runTool(name, params && params.arguments);
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        return reply(id, {
          content: [{ type: 'text', text: `Araç hatası: ${err.message}` }],
          isError: true
        });
      }
    }

    default:
      return replyError(id, -32601, `Desteklenmeyen metot: ${method}`);
  }
}

// Uçuşta olan istekleri say: stdin kapansa bile yanıtı yazmadan çıkma.
let pending = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { continue; }

    pending++;
    handle(msg)
      .catch((err) => {
        if (msg && msg.id != null) replyError(msg.id, -32603, err.message);
      })
      .finally(() => { pending--; maybeExit(); });
  }
});

process.stdin.on('end', () => { stdinClosed = true; maybeExit(); });
