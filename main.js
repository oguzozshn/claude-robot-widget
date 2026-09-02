'use strict';
const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const DEFAULTS = {
  x: null,
  y: null,
  size: 180,
  theme: 'neon',
  sound: true,
  alwaysOnTop: true,
  clickThrough: true,
  port: 47821
};

const THEMES = ['neon', 'silver', 'blue', 'red', 'pastel'];
const THEME_LABEL = { neon: 'Neon (cyan)', silver: 'Gümüş', blue: 'Mavi', red: 'Kırmızı', pastel: 'Pastel' };
const SIZES = [120, 150, 180, 200, 240];
const STATES = ['idle', 'thinking', 'working', 'writing', 'waiting', 'success', 'error'];

let win = null;
let cfg = { ...DEFAULTS };
let cfgPath = null;
let server = null;

// Durumlar ana süreçte oturum bazında tutulur; renderer yeniden yüklense de
// kaybolmaz. Ekranda gösterilen şey bu tablonun özetidir (bkz. aggregate).
const PRIORITY = {
  waiting: 60,   // seni bekliyor -> her şeyi ezer, başka oturum bunu gizleyemez
  error: 50,
  writing: 41,
  working: 40,
  thinking: 30,
  success: 20,
  idle: 0
};
const SESSION_TTL_MS = 10 * 60 * 1000;   // sessiz kalan oturum düşer

const sessions = new Map();   // sessionId -> { state, text, project, at, revertTimer }
let lastSignature = '';

/* ------------------------------------------------------------------ config */

function loadConfig() {
  cfgPath = path.join(app.getPath('userData'), 'config.json');
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
  } catch {
    cfg = { ...DEFAULTS };
  }
  if (process.env.CLAUDE_ROBOT_PORT) cfg.port = Number(process.env.CLAUDE_ROBOT_PORT);
  if (!SIZES.includes(cfg.size)) cfg.size = DEFAULTS.size;
  if (!THEMES.includes(cfg.theme)) cfg.theme = DEFAULTS.theme;
}

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    } catch (err) {
      console.error('[robot] config kaydedilemedi:', err.message);
    }
  }, 250);
}

/* ------------------------------------------------------------------ window */

function windowSize() {
  return { width: cfg.size, height: Math.round(cfg.size * 1.3) };
}

function clampToDisplay(x, y, w, h) {
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - w),
    y: Math.min(Math.max(y, area.y), area.y + area.height - h)
  };
}

function defaultPosition(w, h) {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - w - 32, y: area.y + area.height - h - 32 };
}

function createWindow() {
  const { width, height } = windowSize();
  const pos = (cfg.x === null || cfg.y === null)
    ? defaultPosition(width, height)
    : clampToDisplay(cfg.x, cfg.y, width, height);

  win = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: cfg.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  if (cfg.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer.html'));

  win.webContents.on('did-finish-load', () => {
    if (cfg.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
    pushConfig();
    lastSignature = '';        // renderer yeniden yüklendi, özeti tazeden gönder
    publish(true);
  });

  win.on('closed', () => { win = null; });
}

function pushConfig() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('config', {
      theme: cfg.theme,
      sound: cfg.sound,
      size: cfg.size,
      clickThrough: cfg.clickThrough
    });
  }
}

/* -------------------------------------------------------------- state relay */

// Tablodan ekrana çıkacak özeti hesaplar: en yüksek öncelikli oturum kazanır,
// eşitlikte en son konuşan. Noktalar için de oturum listesini döndürür.
function aggregate() {
  if (sessions.size === 0) {
    return { state: 'idle', text: null, project: null, dots: [], count: 0 };
  }
  let top = null;
  for (const e of sessions.values()) {
    if (!top ||
        PRIORITY[e.state] > PRIORITY[top.state] ||
        (PRIORITY[e.state] === PRIORITY[top.state] && e.at > top.at)) {
      top = e;
    }
  }
  const dots = [...sessions.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, 5)
    .map((e) => e.state !== 'idle');
  return { state: top.state, text: top.text, project: top.project, dots, count: sessions.size };
}

function publish(silent) {
  const agg = aggregate();
  const sig = JSON.stringify(agg);
  if (sig === lastSignature) return agg;
  lastSignature = sig;
  if (win && !win.isDestroyed()) {
    win.webContents.send('state', { ...agg, silent: !!silent });
  }
  return agg;
}

function setSessionState(id, state, opts = {}) {
  if (!STATES.includes(state)) {
    return { ok: false, error: `bilinmeyen durum "${state}" (geçerli: ${STATES.join(', ')})` };
  }
  id = id || 'default';
  const prev = sessions.get(id);
  if (prev && prev.revertTimer) clearTimeout(prev.revertTimer);

  const entry = {
    state,
    text: opts.text ? String(opts.text).slice(0, 32) : null,
    // proje adı bir kez öğrenilir, sonraki olaylarda taşınır
    project: opts.project ? String(opts.project).slice(0, 32) : (prev ? prev.project : null),
    at: Date.now(),
    revertTimer: null
  };
  sessions.set(id, entry);

  if (opts.durationMs > 0) {
    entry.revertTimer = setTimeout(
      () => setSessionState(id, opts.revertTo || 'idle', { project: entry.project }),
      opts.durationMs
    );
  }

  publish(opts.silent);
  return { ok: true, ...aggregate() };
}

function endSession(id) {
  id = id || 'default';
  const e = sessions.get(id);
  if (e && e.revertTimer) clearTimeout(e.revertTimer);
  sessions.delete(id);
  publish();
  return { ok: true, ...aggregate() };
}

// Çöken ya da SessionEnd göndermeden kapanan oturumlar sonsuza dek asılı kalmasın.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, e] of sessions) {
    if (now - e.at > SESSION_TTL_MS) {
      if (e.revertTimer) clearTimeout(e.revertTimer);
      sessions.delete(id);
      changed = true;
    }
  }
  if (changed) publish();
}, 60 * 1000).unref();

/* ---------------------------------------------------------- control server */

function readBody(req, cb) {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 1e5) req.destroy();
  });
  req.on('end', () => {
    try { cb(null, JSON.parse(raw || '{}')); }
    catch { cb(new Error('geçersiz JSON')); }
  });
}

function startServer() {
  server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && (req.url === '/state' || req.url === '/')) {
      return send(200, {
        ok: true,
        ...aggregate(),
        theme: cfg.theme,
        size: cfg.size,
        detail: [...sessions.entries()].map(([id, e]) => ({
          id, state: e.state, text: e.text, project: e.project, idleMs: Date.now() - e.at
        }))
      });
    }

    if (req.method === 'POST' && req.url === '/state') {
      return readBody(req, (err, body) => {
        if (err) return send(400, { ok: false, error: err.message });
        // SessionEnd: oturumu tablodan tamamen düşür
        if (body.end) return send(200, endSession(body.sessionId));
        const result = setSessionState(body.sessionId, body.state, {
          text: body.text,
          project: body.project,
          durationMs: Number(body.durationMs) || 0,
          revertTo: body.revertTo
        });
        send(result.ok ? 200 : 400, result);
      });
    }

    if (req.method === 'POST' && req.url === '/theme') {
      return readBody(req, (err, body) => {
        if (err) return send(400, { ok: false, error: err.message });
        if (!THEMES.includes(body.theme)) return send(400, { ok: false, error: 'bilinmeyen tema' });
        cfg.theme = body.theme;
        saveConfig();
        pushConfig();
        send(200, { ok: true, theme: cfg.theme });
      });
    }

    send(404, { ok: false, error: 'not found' });
  });

  // Port zaten doluysa (ikinci bir örnek) widget yine de çalışsın.
  server.on('error', (err) => console.error('[robot] kontrol sunucusu:', err.message));

  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`[robot] kontrol sunucusu: http://127.0.0.1:${cfg.port}`);
  });
}

/* ------------------------------------------------------------ context menu */

function applySize(size) {
  cfg.size = size;
  const { width, height } = windowSize();
  win.setSize(width, height);
  const [x, y] = win.getPosition();
  const c = clampToDisplay(x, y, width, height);
  win.setPosition(c.x, c.y);
  cfg.x = c.x;
  cfg.y = c.y;
  saveConfig();
  pushConfig();
}

function showMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'Claude Robot', enabled: false },
    { type: 'separator' },
    {
      label: 'Robot rengi',
      submenu: THEMES.map((t) => ({
        label: THEME_LABEL[t],
        type: 'radio',
        checked: cfg.theme === t,
        click: () => { cfg.theme = t; saveConfig(); pushConfig(); }
      }))
    },
    {
      label: 'Boyut',
      submenu: SIZES.map((s) => ({
        label: `${s}px`,
        type: 'radio',
        checked: cfg.size === s,
        click: () => applySize(s)
      }))
    },
    { type: 'separator' },
    {
      label: 'Ses efektleri',
      type: 'checkbox',
      checked: cfg.sound,
      click: () => { cfg.sound = !cfg.sound; saveConfig(); pushConfig(); }
    },
    {
      label: 'Her zaman üstte',
      type: 'checkbox',
      checked: cfg.alwaysOnTop,
      click: () => {
        cfg.alwaysOnTop = !cfg.alwaysOnTop;
        win.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver');
        saveConfig();
      }
    },
    {
      label: 'Boşluklardan tıklama geçsin',
      type: 'checkbox',
      checked: cfg.clickThrough,
      click: () => {
        cfg.clickThrough = !cfg.clickThrough;
        win.setIgnoreMouseEvents(cfg.clickThrough, { forward: true });
        saveConfig();
        pushConfig();
      }
    },
    { type: 'separator' },
    {
      label: 'Durum (test)',
      submenu: STATES.map((s) => ({
        label: s.toUpperCase(),
        type: 'radio',
        checked: aggregate().state === s,
        // Menüden verilen durum sahte bir oturum olarak girer, gerçek
        // oturumların tablosunu bozmaz.
        click: () => setSessionState('menu', s, { project: 'MENU' })
      }))
    },
    {
      label: `Oturumlar (${sessions.size})`,
      submenu: sessions.size === 0
        ? [{ label: 'kayıtlı oturum yok', enabled: false }]
        : [...sessions.entries()]
            .sort((a, b) => b[1].at - a[1].at)
            .map(([id, e]) => ({
              label: `${e.project || id.slice(0, 8)} — ${e.state}`,
              click: () => endSession(id)
            }))
            .concat([
              { type: 'separator' },
              { label: 'Tıklayınca o oturum listeden düşer', enabled: false }
            ])
    },
    {
      label: 'Konumu sıfırla',
      click: () => {
        const { width, height } = windowSize();
        const p = defaultPosition(width, height);
        win.setPosition(p.x, p.y);
        cfg.x = p.x;
        cfg.y = p.y;
        saveConfig();
      }
    },
    { type: 'separator' },
    { label: 'Kapat', click: () => app.quit() }
  ]);

  menu.popup({ window: win });
}

/* --------------------------------------------------------------------- ipc */

ipcMain.handle('menu', () => showMenu());

ipcMain.handle('drag-start', () => {
  const [x, y] = win.getPosition();
  return { x, y };
});

ipcMain.on('drag-move', (_e, { x, y }) => {
  if (win && !win.isDestroyed()) win.setPosition(Math.round(x), Math.round(y));
});

ipcMain.on('drag-end', () => {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  cfg.x = x;
  cfg.y = y;
  saveConfig();
});

// Renderer, imleç robotun üstündeyken tıklamaları yakalar; boşluktayken geçirir.
ipcMain.on('set-ignore', (_e, ignore) => {
  if (!win || win.isDestroyed() || !cfg.clickThrough) return;
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

/* -------------------------------------------------------------------- boot */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) win.show(); });

  app.whenReady().then(() => {
    loadConfig();
    createWindow();
    startServer();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (server) server.close(); });
}
