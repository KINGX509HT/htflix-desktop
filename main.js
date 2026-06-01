// ─── HTFLIX Desktop — Electron Main Process ──────────────────────────────────

'use strict';

const {
  app, BrowserWindow, Menu, shell, session, ipcMain, nativeTheme, screen, Notification,
} = require('electron');
const path = require('path');
const fs   = require('fs');
const { exec } = require('child_process');
const { MpvController } = require('./mpv-controller');
const mpv = new MpvController();

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const cfgPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    console.warn('[HTFLIX] config.json parse failed, using defaults:', e.message);
  }
  return {};
}

const cfg = loadConfig();

const HTFLIX_URL   = process.env.HTFLIX_URL   || cfg.htflixUrl || 'https://YOUR_DEPLOYED_URL.replit.app';
const WIN_W        = cfg.windowWidth           || 1440;
const WIN_H        = cfg.windowHeight          || 900;
const MIN_W        = cfg.minWidth              || 1024;
const MIN_H        = cfg.minHeight             || 640;
const START_MAX    = cfg.startMaximized        || false;
const HW_ACCEL     = cfg.hardwareAcceleration !== false;
const DEFAULT_USER_AGENT = cfg.userAgent ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Codec + GPU unlocks ─────────────────────────────────────────────────────
if (HW_ACCEL) {
  // Force hardware HEVC + VAAPI where available
  app.commandLine.appendSwitch('enable-features',
    'PlatformHEVCDecoderSupport,VaapiVideoDecoder,VaapiVideoEncoder,CanvasOopRasterization');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('enable-accelerated-video-decode');
  // Force GPU even on borderline-blocklisted hardware, GPU rasterization, zero-copy textures
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
} else {
  app.disableHardwareAcceleration();
}
// Site isolation off for perf; CORS stays ON. IPTV hosts that don't return
// CORS headers get permissive ones injected in applyIptvHeaders().
app.commandLine.appendSwitch('disable-features',
  'SitePerProcess,IsolateOrigins,CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-site-isolation-trials');

// ── Performance: never throttle the renderer ────────────────────────────────
// Keep timers, animations, and the renderer running at full speed even when
// the window isn't focused or is occluded. Trades a bit of battery for
// consistent playback + UI responsiveness.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Give V8 a bigger old-generation heap (4 GB) so large channel lists and
// thumbnails don't trigger frequent GC pauses.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

// Widevine: Castlabs +wvcus builds auto-manage the CDM via their component
// update service — no manual path or version pin needed.


// ── Window state persistence ──────────────────────────────────────────────────

const STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');

function loadWinState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}
function saveWinState(win) {
  try {
    if (win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
    const b = win.getBounds();
    fs.writeFileSync(STATE_PATH, JSON.stringify(b), 'utf8');
  } catch {}
}

// ── IPTV per-request UA swap ────────────────────────────────────────────────
// Only IPTV upstream hosts get the VLC user-agent; everything else (Gumroad,
// TMDB, htflix.com) keeps the normal browser UA. Also strips Origin / Referer
// and Sec-Fetch-* headers that some providers reject.

const IPTV_HOSTS = new Set((cfg.iptvHosts || []).map(h => h.toLowerCase()));
const IPTV_UA    = cfg.iptvUserAgent || 'VLC/3.0.20 LibVLC/3.0.20';

function isIptvHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const h of IPTV_HOSTS) {
      if (host === h || host.endsWith('.' + h)) return true;
    }
  } catch {}
  return false;
}

function applyIptvHeaders(sess) {
  sess.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!isIptvHost(details.url)) {
      return callback({ requestHeaders: details.requestHeaders });
    }
    const h = { ...details.requestHeaders };
    h['User-Agent'] = IPTV_UA;
    delete h['Origin'];
    delete h['Referer'];
    delete h['Sec-Fetch-Site'];
    delete h['Sec-Fetch-Mode'];
    delete h['Sec-Fetch-Dest'];
    callback({ requestHeaders: h });
  });

  // IPTV upstreams rarely return CORS headers. Since webSecurity is now on,
  // inject permissive Access-Control-* headers on responses from whitelisted
  // IPTV hosts so the renderer can fetch them. Non-IPTV responses are
  // untouched and obey normal CORS.
  sess.webRequest.onHeadersReceived((details, callback) => {
    if (!isIptvHost(details.url)) {
      return callback({ responseHeaders: details.responseHeaders });
    }
    const rh = { ...(details.responseHeaders || {}) };
    rh['Access-Control-Allow-Origin']      = ['*'];
    rh['Access-Control-Allow-Methods']     = ['GET, POST, OPTIONS, HEAD'];
    rh['Access-Control-Allow-Headers']     = ['*'];
    rh['Access-Control-Expose-Headers']    = ['*'];
    callback({ responseHeaders: rh });
  });
}

// ── Security hardening ────────────────────────────────────────────────────
// Every block below is gated on `IS_PROD` so dev runs (`npm start` from
// source) stay debuggable. Packaged builds have everything locked down.

const IS_PROD = app.isPackaged;
const HTFLIX_ORIGIN = (() => {
  try { return new URL(HTFLIX_URL).origin; } catch { return null; }
})();

function isAllowedNavigation(url) {
  try {
    const u = new URL(url);
    if (HTFLIX_ORIGIN && u.origin === HTFLIX_ORIGIN) return true;
    // Internal protocols we use ourselves
    if (u.protocol === 'file:' || u.protocol === 'data:' || u.protocol === 'about:') return true;
    return false;
  } catch { return false; }
}

function isSafeExternalUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

// Applied to EVERY webContents (main HTFLIX, splash, overlay). Blocks every
// known path to DevTools, hostile navigation, popups, and child-webview
// injection. Dev mode skips the bulk so you can still inspect.
function hardenWebContents(wc) {
  if (IS_PROD) {
    // 1. If DevTools ever opens (programmatic, attached debugger, etc), slam it shut.
    wc.on('devtools-opened', () => { try { wc.closeDevTools(); } catch {} });

    // 2. Block keyboard shortcuts to DevTools / view-source.
    wc.on('before-input-event', (event, input) => {
      const k = String(input.key || '').toLowerCase();
      const mod = input.control || input.meta;
      if ((mod && input.shift && (k === 'i' || k === 'j' || k === 'c')) ||
          (mod && input.alt   && (k === 'i' || k === 'u')) ||
          k === 'f12') {
        event.preventDefault();
      }
    });

    // 3. Block right-click context menu (where "Inspect Element" lives).
    wc.on('context-menu', (event) => event.preventDefault());
  }

  // 4. Lock navigation. Any link that would push the renderer off HTFLIX
  //    gets cancelled and (if it's a safe http(s) link) handed to the
  //    system browser.
  wc.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      console.warn('[HTFLIX-SEC] blocked navigation to', url);
      if (isSafeExternalUrl(url)) shell.openExternal(url).catch(() => {});
    }
  });

  // 5. Same rule for `window.open` / target=_blank. Always deny new
  //    BrowserWindow creation from the renderer; route to OS browser if safe.
  wc.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url) && !isAllowedNavigation(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  // 6. Block <webview> tag from ever being attached (defense in depth —
  //    we also set webviewTag:false in webPreferences).
  wc.on('will-attach-webview', (event) => event.preventDefault());
}

// Clears the Service Worker + caches.match() storage for the HTFLIX origin
// at startup so a publish always reflects on next launch. Preserves Cookies,
// localStorage, IndexedDB, Session Storage — login & user state stay intact.
async function bustStaleCaches(sess) {
  try {
    await sess.clearStorageData({
      origin:   HTFLIX_URL,
      storages: ['serviceworkers', 'cachestorage'],
    });
    console.log('[HTFLIX] cleared SW + cachestorage for', HTFLIX_URL);
  } catch (e) {
    console.warn('[HTFLIX] cache-bust failed:', e.message);
  }
}

// One-shot, called once per Session at app start.
function hardenSession(sess) {
  // Deny every browser permission request (camera, mic, geolocation,
  // notifications-from-page, midi, clipboard-read, etc).
  sess.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  sess.setPermissionCheckHandler(() => false);

  // Note: devtools:// / chrome-devtools:// loads are blocked by the
  // will-navigate guard in hardenWebContents — webRequest filters don't
  // accept custom URL schemes, so we rely on the nav guard instead.

  // Refuse downloads — no surprise files dropped on disk via the web layer.
  sess.on('will-download', (event, _item) => event.preventDefault());
}

// ── Create main window ────────────────────────────────────────────────────────

let mainWin = null;

function createWindow() {
  const saved = cfg.rememberWindowSize !== false ? loadWinState() : null;

  mainWin = new BrowserWindow({
    width:           saved ? saved.width  : WIN_W,
    height:          saved ? saved.height : WIN_H,
    x:               saved ? saved.x      : undefined,
    y:               saved ? saved.y      : undefined,
    minWidth:        MIN_W,
    minHeight:       MIN_H,
    backgroundColor: '#0a0a0a',
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: cfg.autoHideMenuBar || false,
    title:           'HTFLIX',
    show:            false,
    webPreferences: {
      preload:                     path.join(__dirname, 'preload.js'),
      nodeIntegration:             false,
      contextIsolation:            true,
      webviewTag:                  false,
      sandbox:                     false,
      allowRunningInsecureContent: false,
      plugins:                     true,
      backgroundThrottling:        false,
      // Hardening
      devTools:                    !IS_PROD, // no DevTools in packaged builds
      spellcheck:                  false,    // don't ship typed text to spell servers
      enableBlinkFeatures:         '',
      disableBlinkFeatures:        'Auxclick', // block middle-click navigation
      autoplayPolicy:              'no-user-gesture-required',
    },
  });

  hardenWebContents(mainWin.webContents);

  if (START_MAX) mainWin.maximize();

  // IPTV UA / header swap + session-wide hardening
  applyIptvHeaders(session.defaultSession);
  hardenSession(session.defaultSession);

  // ── Auto-bust stale Service Worker + cache-storage on every launch ──────
  // HTFLIX's Service Worker can serve old HTML/JS/CSS before even hitting
  // the network, so app updates don't reflect until the SW notices a new
  // version. By clearing the SW registration + its cachestorage at startup
  // (Cookies / localStorage / IndexedDB / login state stay intact), the
  // first navigation always pulls fresh content from htflix.com.
  bustStaleCaches(session.defaultSession).catch(() => {});

  // Forward mpv events to the renderer (mpv:event), and tear down the
  // overlay window when mpv exits on its own (user pressed Q, closed mpv,
  // stream ended, etc.).
  mpv.onEvent(ev => {
    if (ev && ev.event === 'end') endExternalSession();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('mpv:event', ev);
    }
  });

  // ── Window events ─────────────────────────────────────────────────────────
  mainWin.once('ready-to-show', () => { /* splash timer controls this */ });
  mainWin.on('resize',   () => saveWinState(mainWin));
  mainWin.on('move',     () => saveWinState(mainWin));
  mainWin.on('closed',   () => { mainWin = null; });

  // ── Auto-recover from renderer crashes ────────────────────────────────────
  mainWin.webContents.on('render-process-gone', (_event, details) => {
    console.error('[HTFLIX] Renderer crashed:', details.reason, '— reloading in 1s');
    setTimeout(() => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(HTFLIX_URL).catch(() => {});
    }, 1000);
  });

  mainWin.webContents.on('unresponsive', () => {
    console.warn('[HTFLIX] Renderer unresponsive — reloading in 2s');
    setTimeout(() => {
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.forcefullyCrashRenderer();
        mainWin.loadURL(HTFLIX_URL).catch(() => {});
      }
    }, 2000);
  });

  mainWin.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (errorCode === -3) return;
    if (validatedURL && validatedURL.includes('undefined')) return;
    console.warn('[HTFLIX] Load failed:', errorCode, errorDesc, validatedURL, 'mainFrame=', isMainFrame);
    setTimeout(() => {
      if (mainWin && !mainWin.isDestroyed())
        mainWin.loadURL(HTFLIX_URL, { userAgent: DEFAULT_USER_AGENT }).catch(() => {});
    }, 2000);
  });

  // Dark mode
  nativeTheme.themeSource = 'dark';

  // ── Load the HTFLIX app ───────────────────────────────────────────────────
  // extraHeaders forces a network revalidation on the initial document load
  // — paired with the bustStaleCaches() above, this guarantees the first
  // request after an HTFLIX publish pulls the new HTML, not a stale copy.
  mainWin.loadURL(HTFLIX_URL, {
    userAgent: DEFAULT_USER_AGENT,
    extraHeaders: 'pragma: no-cache\nCache-Control: no-cache\n',
  }).catch(() => {
    mainWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html><html><head><style>
        body{background:#0a0a0a;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;
             align-items:center;justify-content:center;height:100vh;margin:0;gap:16px}
        h1{color:#e50914;font-size:2rem;margin:0}p{color:#aaa;font-size:.95rem;max-width:480px;text-align:center}
        code{background:#1a1a1a;padding:4px 8px;border-radius:4px;color:#e50914;font-size:.85rem}a{color:#e50914}
      </style></head><body>
        <h1>HTFLIX</h1>
        <p>Could not connect to <code>${HTFLIX_URL}</code></p>
        <p>Update <code>config.json</code> with your deployed URL, then relaunch.</p>
        <p><a href="${HTFLIX_URL}">Retry</a></p>
      </body></html>
    `)}`);
  });

  // ── Health check every 30s (fallback for stuck-but-not-crashed pages) ───
  // render-process-gone + unresponsive cover crashes/hangs; this probe only
  // catches a third failure mode (alive renderer, missing document.body —
  // e.g. blank navigation or SSL interstitial). 30s is plenty for a fallback
  // and keeps idle wakeups low on battery.
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = setInterval(() => {
    if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) {
      mainWin.webContents.executeJavaScript('document.body ? "ok" : "dead"').catch(() => {
        console.log('[HTFLIX] Health check: page died — reloading');
        mainWin.loadURL(HTFLIX_URL).catch(() => {});
      });
    }
  }, 30000);

  return mainWin;
}

let healthCheckTimer = null;

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('open-external', (_, url) => {
  if (!isSafeExternalUrl(url)) throw new Error('open-external: url must be http(s)');
  return shell.openExternal(url);
});
ipcMain.handle('window-minimize',     ()        => mainWin?.minimize());
ipcMain.handle('window-maximize',     ()        => mainWin?.isMaximized() ? mainWin.unmaximize() : mainWin.maximize());
ipcMain.handle('window-close',        ()        => mainWin?.close());
ipcMain.handle('window-is-maximized', ()        => mainWin?.isMaximized() ?? false);
ipcMain.handle('install-update',      ()        => { try { require('electron-updater').autoUpdater.quitAndInstall(); } catch {} });

// ── mpv sidecar IPC ─────────────────────────────────────────────────────────
ipcMain.handle('mpv:available',  ()              => mpv.available());
function computeInitialMpvBounds() {
  // Open the standalone player at the HTFLIX window's content size when
  // available, otherwise 92% of the screen work area, centered. After spawn
  // mpv is an independent window — user can resize/move it freely.
  if (mainWin && !mainWin.isDestroyed()) {
    const b = mainWin.getContentBounds();
    if (b.width >= 800 && b.height >= 500) return b;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  const width  = Math.round(wa.width  * 0.92);
  const height = Math.round(wa.height * 0.92);
  return {
    x: wa.x + Math.round((wa.width  - width)  / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
    width, height,
  };
}

// ── External player: standalone fullscreen mpv + transparent overlay ─────
// The bundled mpv binary is a Vulkan-only build with no Cocoa-GL VO, so
// --wid subview embedding can't auto-resize on macOS. Instead we run mpv
// as its own standalone fullscreen window (mpv owns its NSWindow, macOS
// sizes it perfectly) and float the transparent HTFLIX controls overlay
// above it. setVisibleOnAllWorkspaces({visibleOnFullScreen:true}) makes
// the overlay appear on top of mpv's fullscreen Space.
let overlayWin            = null;
let videoWin              = null;  // Windows-only: hosts mpv child HWND
let lastChannelMeta       = null;
let externalSessionActive = false;
let preExternalMainBounds = null;
let overlayMode           = 'fullscreen'; // 'fullscreen' | 'windowed'

// The display mpv + overlay should land on. Whichever screen the main HTFLIX
// window currently lives on (or where it was last visible — getBounds still
// reports the saved rect after .hide()). Falls back to primary.
function targetDisplay() {
  if (mainWin && !mainWin.isDestroyed()) {
    try { return screen.getDisplayMatching(mainWin.getBounds()); } catch {}
  }
  return screen.getPrimaryDisplay();
}

function workAreaBounds() {
  return targetDisplay().workArea;
}

function destroyOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    try { overlayWin.close(); } catch {}
  }
  overlayWin = null;
}

// Windows-only: black-filled BrowserWindow whose native HWND is handed to
// mpv via --wid. mpv attaches as a WS_CHILD and fills the client area. The
// transparent controls overlay floats above this window at the same bounds.
function destroyVideoWin() {
  if (videoWin && !videoWin.isDestroyed()) {
    try { videoWin.close(); } catch {}
  }
  videoWin = null;
}

function createVideoWin(bounds) {
  destroyVideoWin();
  videoWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame:           false,
    backgroundColor: '#000000',
    show:            false,
    skipTaskbar:     false,
    title:           'HTFLIX',
    fullscreenable:  true,
    webPreferences: {
      nodeIntegration:      false,
      contextIsolation:     true,
      sandbox:              true,
      backgroundThrottling: false,
      devTools:             !IS_PROD,
      spellcheck:           false,
      webviewTag:           false,
    },
  });
  hardenWebContents(videoWin.webContents);
  // Black canvas — mpv's child HWND will draw over the entire client area.
  videoWin.loadURL('data:text/html;charset=utf-8,' +
    encodeURIComponent('<body style="margin:0;background:#000;overflow:hidden;"></body>'));
  videoWin.on('closed', () => { videoWin = null; });
  return videoWin;
}

// Native window handle as a decimal string. On Windows getNativeWindowHandle()
// returns a Buffer containing the HWND (pointer-sized). mpv's --wid expects
// a decimal integer.
function nativeHandleString(win) {
  const buf = win.getNativeWindowHandle();
  if (process.platform === 'win32') {
    // HWND is pointer-sized: 8 bytes on x64, 4 on ia32.
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    return buf.readUInt32LE(0).toString();
  }
  // Linux X11: XID is 32-bit. macOS doesn't use --wid for our binary.
  return buf.readUInt32LE(0).toString();
}

function createOverlay(bounds) {
  destroyOverlay();
  overlayWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame:           false,
    transparent:     true,
    hasShadow:       false,
    resizable:       true,
    movable:         true,
    minimizable:     true,
    maximizable:     true,
    fullscreenable:  true,
    skipTaskbar:     false,
    backgroundColor: '#00000000',
    title:           'HTFLIX External Player',
    minWidth:        480,
    minHeight:       320,
    webPreferences: {
      preload:              path.join(__dirname, 'overlay-preload.js'),
      nodeIntegration:      false,
      contextIsolation:     true,
      sandbox:              true,
      backgroundThrottling: false,
      devTools:             !IS_PROD,
      spellcheck:           false,
      webviewTag:           false,
      enableBlinkFeatures:  '',
      disableBlinkFeatures: 'Auxclick',
    },
  });
  hardenWebContents(overlayWin.webContents);
  // 'screen-saver' (level 1000) guarantees the overlay stays above mpv's
  // borderless fullscreen window.
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile(path.join(__dirname, 'external-player.html'));

  // Simple fullscreen = pre-Lion fullscreen: covers menu bar + entire
  // screen, NO Space switch. Deferred until ready-to-show because calling
  // setSimpleFullScreen synchronously while the previous overlay's close
  // is still in transit throws NSGenericException ("NSWindowStyleMaskFullScreen
  // set on a window outside of a full screen transition") and that NSException
  // can't be caught by JS — it aborts the whole Electron process.
  overlayWin.once('ready-to-show', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (process.platform === 'darwin') {
      try { overlayWin.setSimpleFullScreen(true); } catch {}
    } else {
      try { overlayWin.setFullScreen(true); } catch {}
    }
  });

  overlayWin.webContents.once('did-finish-load', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      if (lastChannelMeta) overlayWin.webContents.send('overlay:channel', lastChannelMeta);
      overlayWin.webContents.send('overlay:window-state', {
        fullscreen: overlayMode === 'fullscreen',
        maximized:  false,
      });
      // mpv steals focus when it spawns its NSWindow. Yank it back so the
      // overlay's keydown listener actually fires for SPACE/M/F/[/]/etc.
      // Has to happen AFTER load so the webContents focus call has effect.
      try { overlayWin.show(); } catch {}
      try { overlayWin.focus(); } catch {}
      try { overlayWin.webContents.focus(); } catch {}
      if (process.platform === 'darwin') {
        try { app.focus({ steal: true }); } catch {}
      }
    }
  });

  // If the user un-minimizes the overlay from the dock, bring mpv back too.
  overlayWin.on('restore', () => { mpv.unminimize().catch(() => {}); });

  overlayWin.on('closed', () => { overlayWin = null; });
}

// ── Player mode (fullscreen ⟷ windowed) ────────────────────────────────────
function setOverlayFullScreen(on) {
  if (process.platform === 'darwin') {
    try { overlayWin.setSimpleFullScreen(on); } catch {}
  } else {
    try { overlayWin.setFullScreen(on); } catch {}
  }
}

function setOverlayMode(mode) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayMode = mode;
  if (mode === 'fullscreen') {
    setOverlayFullScreen(true);
    mpv.fullscreen(true).catch(() => {});
  } else {
    setOverlayFullScreen(false);
    const wa = workAreaBounds();
    const w  = Math.round(wa.width  * 0.75);
    const h  = Math.round(wa.height * 0.75);
    const x  = wa.x + Math.round((wa.width  - w) / 2);
    const y  = wa.y + Math.round((wa.height - h) / 2);
    try { overlayWin.setBounds({ x, y, width: w, height: h }); } catch {}
    mpv.fullscreen(false).catch(() => {});
    // Give mpv a tick to exit fullscreen before forcing its bounds.
    setTimeout(() => { mpv.setBounds({ x, y, width: w, height: h }).catch(() => {}); }, 80);
  }
  try {
    overlayWin.webContents.send('overlay:window-state', {
      fullscreen: mode === 'fullscreen',
      maximized:  false,
    });
    overlayWin.focus();
  } catch {}
}

function sendOverlayChannel(meta) {
  lastChannelMeta = meta || null;
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay:channel', meta || {});
  }
}

// ── External-player session orchestration ──────────────────────────────────
// When mpv starts playing, the main HTFLIX window goes away entirely so the
// user only sees the external player. The embedded <video> is paused via JS
// injection (works without any HTFLIX-side changes) and an IPC event is also
// fired so the web app can opt-in to cleaner handling.

const PAUSE_EMBEDDED_JS = `
  (function () {
    try {
      var bag = window.__htflixPausedMedia = window.__htflixPausedMedia || [];
      document.querySelectorAll('video, audio').forEach(function (m) {
        if (!m.paused) { try { m.pause(); bag.push(m); } catch (_) {} }
      });
    } catch (_) {}
  })();
`;

// Resumes only the elements we paused — doesn't auto-play media the user
// had stopped before opening the external player.
const RESUME_EMBEDDED_JS = `
  (function () {
    try {
      var bag = window.__htflixPausedMedia || [];
      bag.forEach(function (m) { try { m.play().catch(function(){}); } catch (_) {} });
      window.__htflixPausedMedia = [];
    } catch (_) {}
  })();
`;

function pauseEmbeddedMedia() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try { mainWin.webContents.send('htflix:pause-embedded'); } catch {}
  mainWin.webContents.executeJavaScript(PAUSE_EMBEDDED_JS, true).catch(() => {});
}

function resumeEmbeddedMedia() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try { mainWin.webContents.send('htflix:resume-embedded'); } catch {}
  mainWin.webContents.executeJavaScript(RESUME_EMBEDDED_JS, true).catch(() => {});
}

function beginExternalSession() {
  if (externalSessionActive) return;
  externalSessionActive = true;
  if (mainWin && !mainWin.isDestroyed()) {
    preExternalMainBounds = mainWin.getBounds();
    try { mainWin.webContents.setAudioMuted(true); } catch {}
    pauseEmbeddedMedia();
    try { mainWin.webContents.send('htflix:external-opened'); } catch {}
    mainWin.hide();
  }
}

function endExternalSession() {
  destroyOverlay();
  destroyVideoWin();
  if (!externalSessionActive) return;
  externalSessionActive = false;
  if (mainWin && !mainWin.isDestroyed()) {
    try { mainWin.webContents.setAudioMuted(false); } catch {}
    if (preExternalMainBounds) {
      try { mainWin.setBounds(preExternalMainBounds); } catch {}
    }
    // Tiny delay so the overlay's close animation completes before the
    // main window re-appears — avoids a one-frame flash.
    setTimeout(() => {
      if (!mainWin || mainWin.isDestroyed()) return;
      mainWin.show();
      mainWin.focus();
      try { mainWin.webContents.send('htflix:external-closed'); } catch {}
      resumeEmbeddedMedia();
    }, 60);
  }
}

// Bridge overlay events → mpv IPC / main window
ipcMain.on('overlay:close',  () => { mpv.stop().catch(() => {}); endExternalSession(); });
ipcMain.on('overlay:toggle', () => { mpv.togglePause().catch(() => {}); });
ipcMain.on('overlay:mute',   (_e, b) => { mpv.mute(b).catch(() => {}); });
ipcMain.on('overlay:volume', (_e, v) => { mpv.setVolume(v).catch(() => {}); });

ipcMain.on('overlay:minimize', () => {
  // Minimize both windows to the dock. Have to exit simpleFullScreen first
  // because macOS can't minimize a simple-fullscreen window cleanly.
  if (overlayWin && !overlayWin.isDestroyed()) {
    setOverlayFullScreen(false);
  }
  // Drop mpv out of fullscreen, then minimize after a tick — same 80ms
  // pacing as setOverlayMode uses so mpv has time to leave fullscreen
  // before the minimize command lands.
  mpv.fullscreen(false).catch(() => {});
  setTimeout(() => {
    mpv.minimize().catch(() => {});
    if (overlayWin && !overlayWin.isDestroyed()) {
      try { overlayWin.minimize(); } catch {}
    }
  }, 80);
});

// Restore from the dock — un-minimize both windows and put mpv back on top.
ipcMain.on('overlay:restore', () => {
  mpv.unminimize().catch(() => {});
  if (overlayWin && !overlayWin.isDestroyed()) {
    try { overlayWin.restore(); } catch {}
    try { overlayWin.focus(); } catch {}
  }
});

ipcMain.on('overlay:maximize-toggle', () => {
  // Treat "maximize" as "ensure fullscreen" for this player — flips back to
  // fullscreen if currently windowed, otherwise drops to windowed centered.
  setOverlayMode(overlayMode === 'fullscreen' ? 'windowed' : 'fullscreen');
});

ipcMain.on('overlay:fullscreen-toggle', () => {
  setOverlayMode(overlayMode === 'fullscreen' ? 'windowed' : 'fullscreen');
});

ipcMain.on('overlay:prev-channel', () => mainWin?.webContents.send('htflix:prev-channel'));
ipcMain.on('overlay:next-channel', () => mainWin?.webContents.send('htflix:next-channel'));

// Cast / AirPlay — opens the macOS Displays preferences pane which has the
// AirPlay receiver picker. With mpv on screen, mirroring the desktop to an
// Apple TV broadcasts the stream. On non-macOS, just notifies + forwards
// to the (hidden) HTFLIX web app in case it wants to handle casting itself.
ipcMain.on('overlay:cast', () => {
  if (process.platform === 'darwin') {
    exec('open "x-apple.systempreferences:com.apple.preference.displays"', (err) => {
      if (err) {
        console.warn('[HTFLIX] cast: could not open Displays prefs:', err.message);
        try {
          new Notification({
            title: 'Couldn’t open AirPlay settings',
            body:  'Open System Settings → Displays manually, then pick an AirPlay receiver.',
          }).show();
        } catch {}
        return;
      }
      try {
        new Notification({
          title: 'AirPlay / Screen Mirroring',
          body:  'Pick your Apple TV in System Settings → Displays → AirPlay Display, or use Control Center → Screen Mirroring.',
        }).show();
      } catch {}
    });
  } else {
    try {
      new Notification({
        title: 'Casting',
        body:  'Use your operating system’s screen mirroring to cast this stream.',
      }).show();
    } catch {}
  }
  // Also let the HTFLIX web app react if it has its own cast handler wired.
  try { mainWin?.webContents.send('htflix:start-cast'); } catch {}
});

// Serialize mpv:play. The web app sometimes double-fires the IPC (rapid
// click / re-render); without this guard the second call races the first,
// kills its mpv mid-spawn, and the createOverlay/destroyOverlay churn
// trips a macOS NSWindow fullscreen-transition exception that aborts the
// whole process.
let mpvPlayInFlight = false;
ipcMain.handle('mpv:play',       async (_e, url, opts) => {
  if (mpvPlayInFlight) {
    console.log('[HTFLIX] mpv:play ignored — another play already in flight');
    return;
  }
  mpvPlayInFlight = true;
  try {
    console.log('[HTFLIX] mpv:play raw=', url);
    if (!url || typeof url !== 'string') {
      throw new Error('mpv:play called with no URL');
    }
    let abs = url;
    try { abs = new URL(url, HTFLIX_URL).href; } catch {}
    // Stream URL must be http(s) — block file://, dvd://, javascript:, etc.
    // that mpv would otherwise happily try to play. Closes a major attack
    // vector if the HTFLIX page is ever compromised.
    if (!isSafeExternalUrl(abs)) {
      throw new Error('mpv:play: stream URL must be http or https');
    }
    // Reject obviously-broken URLs: missing channel id (/stream/null), undefined token, etc.
    if (/\/(null|undefined)(\?|$)/i.test(abs) || /token=(null|undefined)(&|$)/i.test(abs)) {
      throw new Error('Stream URL is not ready yet (got placeholder: ' + abs + ')');
    }
    console.log('[HTFLIX] mpv:play resolved=', abs);

    // Both mpv and the overlay land on the SAME display — whichever screen
    // the HTFLIX main window lives on — so they don't split across monitors.
    const display = targetDisplay();
    overlayMode = 'fullscreen';

    if (process.platform === 'win32') {
      // Windows: mpv embeds as a child HWND of an Electron BrowserWindow
      // (videoWin). One parent window owns video; the transparent controls
      // overlay floats above. Avoids DWM transparency / DXGI fullscreen
      // races, focus-stealing, and z-order fights that the macOS
      // two-NSWindow pattern would trigger here.
      const vw = createVideoWin(display.bounds);
      await new Promise(resolve => {
        if (vw.webContents.isLoading()) {
          vw.webContents.once('did-finish-load', resolve);
        } else {
          resolve();
        }
      });
      vw.show();
      try { vw.setFullScreen(true); } catch {}
      const embedWid = nativeHandleString(vw);
      const finalOpts = { ...(opts || {}), embedWid };
      try {
        await mpv.play(abs, finalOpts);
      } catch (e) {
        destroyVideoWin();
        throw e;
      }
      createOverlay(display.bounds);
    } else {
      // macOS / Linux: standalone mpv window + transparent overlay above.
      // mpv owns its NSWindow/XID and renders edge-to-edge. setSimpleFullScreen
      // (deferred until ready-to-show in createOverlay) covers the same pixels
      // as mpv on the same desktop; 'screen-saver' window level keeps it above.
      const finalOpts = { ...(opts || {}), bounds: display.workArea, fullscreen: true };
      await mpv.play(abs, finalOpts);
      createOverlay(display.bounds);
    }

    beginExternalSession();
    if (opts && opts.channel) sendOverlayChannel(opts.channel);
  } finally {
    mpvPlayInFlight = false;
  }
});

// Web app can push updated channel metadata to the overlay any time.
ipcMain.on('mpv:set-channel', (_e, meta) => sendOverlayChannel(meta));
ipcMain.handle('mpv:stop',       ()              => mpv.stop());
ipcMain.handle('mpv:pause',      ()              => mpv.pause());
ipcMain.handle('mpv:resume',     ()              => mpv.resume());
ipcMain.handle('mpv:toggle',     ()              => mpv.togglePause());
ipcMain.handle('mpv:volume',     (_e, v)         => mpv.setVolume(v));
ipcMain.handle('mpv:mute',       (_e, b)         => mpv.mute(b));
ipcMain.handle('mpv:bounds',     (_e, b)         => mpv.setBounds(b));
ipcMain.handle('mpv:fullscreen', (_e, b)         => mpv.fullscreen(b));

// ── App menu ─────────────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      { role: 'quit' },
    ]}] : []),
    { label: '&File', submenu: [ isMac ? { role: 'close' } : { role: 'quit' } ] },
    { label: '&View', submenu: [
      { label: 'Home',         accelerator: 'CmdOrCtrl+H',         click: () => mainWin?.loadURL(HTFLIX_URL) },
      { label: 'Reload',       accelerator: 'CmdOrCtrl+R',         click: () => mainWin?.webContents.reload() },
      { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R',   click: () => mainWin?.webContents.reloadIgnoringCache() },
      { label: 'Hard Refresh (clear cache + service worker)',
        accelerator: 'CmdOrCtrl+Alt+Shift+R',
        click: async () => {
          if (!mainWin || mainWin.isDestroyed()) return;
          const sess = mainWin.webContents.session;
          try {
            await sess.clearCache();
            await sess.clearStorageData({ storages: ['serviceworkers', 'cachestorage', 'shadercache', 'codecache'] });
            console.log('[HTFLIX] hard refresh: caches + service worker cleared');
          } catch (e) {
            console.warn('[HTFLIX] hard refresh failed:', e.message);
          }
          mainWin.loadURL(HTFLIX_URL).catch(() => {});
        },
      },
      { type: 'separator' },
      { label: 'Zoom In',  accelerator: 'CmdOrCtrl+=', click: () => { const z = (mainWin?.webContents.getZoomFactor() ?? 1) + 0.1; mainWin?.webContents.setZoomFactor(Math.min(z, 2.5)); } },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => { const z = (mainWin?.webContents.getZoomFactor() ?? 1) - 0.1; mainWin?.webContents.setZoomFactor(Math.max(z, 0.5)); } },
      { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => mainWin?.webContents.setZoomFactor(1) },
      ...(!IS_PROD ? [
        { type: 'separator' },
        { label: 'Toggle Developer Tools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => mainWin?.webContents.toggleDevTools() },
      ] : []),
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ]},
    { label: '&Window', submenu: [
      { role: 'minimize' }, { role: 'zoom' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

app.on('browser-window-created', (_, win) => {
  win.webContents.on('before-input-event', (event, input) => {
    const ctrl = input.control || input.meta;
    if (ctrl && input.key === 'ArrowLeft')  { event.preventDefault(); win.webContents.goBack();    }
    if (ctrl && input.key === 'ArrowRight') { event.preventDefault(); win.webContents.goForward(); }
    if (input.key === 'F5')                 { event.preventDefault(); win.webContents.reload();    }
  });
});

// ── Splash window ─────────────────────────────────────────────────────────────

let splashWin = null;

function createSplashWindow() {
  splashWin = new BrowserWindow({
    width: WIN_W, height: WIN_H, center: true, backgroundColor: '#000000',
    frame: false, resizable: false, movable: true, title: 'HTFLIX', show: false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
      devTools:         !IS_PROD,
      spellcheck:       false,
      webviewTag:       false,
    },
  });
  hardenWebContents(splashWin.webContents);
  splashWin.loadFile(path.join(__dirname, 'splash.html'));
  splashWin.once('ready-to-show', () => { if (splashWin) splashWin.show(); });
  splashWin.on('closed', () => { splashWin = null; });

  setTimeout(() => {
    if (splashWin && !splashWin.isDestroyed()) splashWin.close();
    if (mainWin  && !mainWin.isDestroyed()) {
      mainWin.show();
      if (process.platform === 'darwin') app.dock.setBadge('');
    }
  }, 3200);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createSplashWindow();
  createWindow();
  buildMenu();

  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    autoUpdater.on('update-available',  (info) => mainWin?.webContents.send('update-available', info));
    autoUpdater.on('update-downloaded', (info) => mainWin?.webContents.send('update-downloaded', info));
  } catch {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) { createWindow(); return; }
    if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.focus(); return; }
    if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) mainWin.show();
  });
});

app.on('before-quit', () => {
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
  try { mpv.stop(); } catch {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
