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
const STATES = ['idle', 'thinking', 'working', 'waiting', 'success', 'error'];

let win = null;
let cfg = { ...DEFAULTS };
let cfgPath = null;
let server = null;

// Durum ana süreçte tutulur; renderer yeniden yüklense de kaybolmaz.
let current = { state: 'idle', text: null, at: Date.now() };
let revertTimer = null;

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
    pushState(current.state, current.text, { silent: true });
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

function pushState(state, text, opts = {}) {
  if (!STATES.includes(state)) {
    return { ok: false, error: `bilinmeyen durum "${state}" (geçerli: ${STATES.join(', ')})` };
  }
  current = { state, text: text ? String(text).slice(0, 32) : null, at: Date.now() };

  clearTimeout(revertTimer);
  if (opts.durationMs > 0) {
    revertTimer = setTimeout(() => pushState(opts.revertTo || 'idle', null), opts.durationMs);
  }

  if (win && !win.isDestroyed()) {
    win.webContents.send('state', { ...current, silent: !!opts.silent });
  }
  return { ok: true, state: current.state, text: current.text };
}

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
      return send(200, { ok: true, ...current, theme: cfg.theme, size: cfg.size });
    }

    if (req.method === 'POST' && req.url === '/state') {
      return readBody(req, (err, body) => {
        if (err) return send(400, { ok: false, error: err.message });
        const result = pushState(body.state, body.text, {
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
        checked: current.state === s,
        click: () => pushState(s, null)
      }))
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
