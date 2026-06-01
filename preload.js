// ─── HTFLIX Desktop — Main Window Preload ────────────────────────────────────
// Runs in the isolated world of the main BrowserWindow.
// Uses contextBridge to safely expose any needed APIs to the renderer.
//
// SECURITY: every argument crossing the contextBridge is type-checked and,
// where applicable, range/format-validated. Anything that fails validation
// silently no-ops (no throw → no error message that could leak internals).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ── Validators ────────────────────────────────────────────────────────────
const isStr  = (v) => typeof v === 'string';
const isBool = (v) => typeof v === 'boolean';
const isNum  = (v) => typeof v === 'number' && Number.isFinite(v);
const isFn   = (v) => typeof v === 'function';
const isObj  = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function isHttpUrl(u) {
  if (!isStr(u)) return false;
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; }
  catch { return false; }
}

function isBounds(b) {
  return isObj(b) && isNum(b.x) && isNum(b.y) && isNum(b.width) && isNum(b.height);
}

// Pick only the keys mpv:play actually reads from opts. Anything else from
// a hostile renderer is silently dropped — no opportunity to smuggle args
// past the validator.
function sanitizeMpvOpts(o) {
  if (!isObj(o)) return {};
  const out = {};
  if (isBool(o.fullscreen)) out.fullscreen = o.fullscreen;
  if (isStr(o.userAgent) && o.userAgent.length < 512) out.userAgent = o.userAgent;
  if (isBounds(o.bounds)) out.bounds = {
    x: o.bounds.x, y: o.bounds.y, width: o.bounds.width, height: o.bounds.height,
  };
  if (isObj(o.channel)) out.channel = sanitizeChannelMeta(o.channel);
  return out;
}

function sanitizeChannelMeta(c) {
  if (!isObj(c)) return {};
  const out = {};
  if (isStr(c.name)  && c.name.length  < 200) out.name = c.name;
  if (isStr(c.sub)   && c.sub.length   < 200) out.sub  = c.sub;
  if (isStr(c.logo)  && c.logo.length  < 2000 && /^(https?:|data:image\/)/i.test(c.logo)) out.logo = c.logo;
  if (isNum(c.index)) out.index = c.index;
  if (isNum(c.total)) out.total = c.total;
  if (isBool(c.live)) out.live = c.live;
  return out;
}

function bind(channel, cb) {
  if (!isFn(cb)) return () => {};
  const handler = (_e, ...args) => { try { cb(...args); } catch (_) {} };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// ── Exposed API ───────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('htflixDesktop', {
  platform: process.platform,
  version:  process.env.npm_package_version || '1.0.0',

  openExternal: (url) => isHttpUrl(url) ? ipcRenderer.invoke('open-external', url) : Promise.reject(new Error('invalid url')),
  minimize:     ()    => ipcRenderer.invoke('window-minimize'),
  maximize:     ()    => ipcRenderer.invoke('window-maximize'),
  close:        ()    => ipcRenderer.invoke('window-close'),
  isMaximized:  ()    => ipcRenderer.invoke('window-is-maximized'),

  onUpdateAvailable:  (cb) => bind('update-available',  cb),
  onUpdateDownloaded: (cb) => bind('update-downloaded', cb),
  installUpdate:      ()   => ipcRenderer.invoke('install-update'),

  mpv: {
    available:  ()       => ipcRenderer.invoke('mpv:available'),
    play:       (url, o) => isHttpUrl(url)
                              ? ipcRenderer.invoke('mpv:play', url, sanitizeMpvOpts(o))
                              : Promise.reject(new Error('mpv.play: url must be http(s)')),
    stop:       ()       => ipcRenderer.invoke('mpv:stop'),
    pause:      ()       => ipcRenderer.invoke('mpv:pause'),
    resume:     ()       => ipcRenderer.invoke('mpv:resume'),
    toggle:     ()       => ipcRenderer.invoke('mpv:toggle'),
    setVolume:  (v)      => isNum(v)    ? ipcRenderer.invoke('mpv:volume', Math.max(0, Math.min(100, v))) : Promise.reject(new Error('volume must be number')),
    mute:       (b)      => isBool(b)   ? ipcRenderer.invoke('mpv:mute', b)        : Promise.reject(new Error('mute must be boolean')),
    setBounds:  (b)      => isBounds(b) ? ipcRenderer.invoke('mpv:bounds', { x: b.x, y: b.y, width: b.width, height: b.height }) : Promise.reject(new Error('bounds invalid')),
    fullscreen: (b)      => isBool(b)   ? ipcRenderer.invoke('mpv:fullscreen', b)  : Promise.reject(new Error('fullscreen must be boolean')),
    setChannel: (meta)   => { ipcRenderer.send('mpv:set-channel', sanitizeChannelMeta(meta)); },
    onEvent:    (cb)     => bind('mpv:event', cb),
  },

  // External-player session events. When mpv takes over, the HTFLIX web app
  // gets a chance to gracefully pause its embedded <video>.
  externalPlayer: {
    onOpened:         (cb) => bind('htflix:external-opened',  cb),
    onClosed:         (cb) => bind('htflix:external-closed',  cb),
    onPauseEmbedded:  (cb) => bind('htflix:pause-embedded',   cb),
    onResumeEmbedded: (cb) => bind('htflix:resume-embedded',  cb),
  },

  // Channel-control events forwarded from the external player overlay back
  // into the HTFLIX web app (e.g. when user clicks "Next channel" inside
  // the external player). Hook these to navigate / refresh the embedded UI.
  on: {
    prevChannel: (cb) => bind('htflix:prev-channel', cb),
    nextChannel: (cb) => bind('htflix:next-channel', cb),
    startCast:   (cb) => bind('htflix:start-cast',   cb),
  },
});
