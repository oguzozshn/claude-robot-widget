#!/usr/bin/env node
'use strict';
/*
 * Claude Robot — Claude Code hook köprüsü
 *
 * İki şekilde çalışır:
 *   1) Hook olarak: Claude Code hook JSON'unu stdin'den okur, olayı duruma çevirir.
 *      .claude/settings.json içinde:  "command": "node C:/.../hook.js"
 *   2) CLI olarak:  node hook.js working BUILD
 *
 * Claude Code'u asla bloklamaz: kısa zaman aşımı, her koşulda exit 0.
 */

const http = require('http');

const PORT = Number(process.env.CLAUDE_ROBOT_PORT) || 47821;

// Hook olayı -> robot durumu.
// error BİLEREK yok: PostToolUse'un exit kodu "hata" demek değildir
// (eşleşme bulamayan grep de 1 döner), robot boşuna kırmızı yanmasın.
// error yalnızca MCP aracıyla, bilinçli olarak tetiklenir.
const MAP = {
  SessionStart:    { state: 'idle' },
  UserPromptSubmit:{ state: 'thinking' },
  PreToolUse:      { state: 'working' },
  PostToolUse:     { state: 'thinking' },
  Notification:    { state: 'waiting' },
  Stop:            { state: 'success', durationMs: 4000, revertTo: 'idle' },
  SubagentStop:    { state: 'working' },
  SessionEnd:      { state: 'idle' }
};

// Dosyaya yazan araçlar 'working' değil 'writing' gösterir: okumak/komut
// çalıştırmak ile kod üretmek farklı işler, robot da farklı davransın.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function baseName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

function send(body) {
  const payload = JSON.stringify(body);
  const req = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/state',
      method: 'POST',
      timeout: 800,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    },
    (res) => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  // Widget kapalıysa sessizce çık — hook başarısız sayılmamalı.
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.write(payload);
  req.end();
}

/* --------------------------------------------------------------- CLI modu */

const [argState, argText] = process.argv.slice(2);
if (argState) {
  send({ state: argState, text: argText, sessionId: 'cli', project: 'CLI' });
  return;
}

/* -------------------------------------------------------------- hook modu */

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let ev = {};
  try { ev = JSON.parse(raw || '{}'); } catch { /* boş gövde de olabilir */ }

  const entry = MAP[ev.hook_event_name];
  if (!entry) process.exit(0);

  const body = { ...entry };

  // Her olay hangi oturumdan geldiğini söyler: widget birden çok oturumu
  // ayrı ayrı takip edip ekranda en öncelikli olanı gösterir.
  body.sessionId = ev.session_id || 'default';
  if (ev.cwd) body.project = baseName(ev.cwd);
  if (ev.hook_event_name === 'SessionEnd') body.end = true;

  if (ev.hook_event_name === 'PreToolUse' && ev.tool_name) {
    if (WRITE_TOOLS.has(ev.tool_name)) {
      // Yazma araçlarında ekranda araç adı yerine dosya adı görünsün.
      const file = ev.tool_input && ev.tool_input.file_path;
      body.state = 'writing';
      body.text = (file ? baseName(file) : ev.tool_name).slice(0, 11);
    } else {
      body.text = String(ev.tool_name).toUpperCase().slice(0, 11);
    }
  }

  send(body);
});

// stdin hiç gelmezse takılıp kalma.
setTimeout(() => process.exit(0), 1500).unref();
