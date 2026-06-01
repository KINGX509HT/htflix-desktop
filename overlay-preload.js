// ─── HTFLIX External Player — Overlay Preload ────────────────────────────────
// Sandboxed preload (sandbox:true + contextIsolation:true). Exposes a tiny
// whitelisted IPC surface to the overlay HTML — every channel + every
// argument is validated, so injected renderer code can't smuggle anything.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Send-side: channel → arg validator. Returning false drops the send.
const SEND_VALIDATORS = {
  'overlay:close':             (a) => a.length === 0,
  'overlay:toggle':            (a) => a.length === 0,
  'overlay:mute':              (a) => a.length === 1 && typeof a[0] === 'boolean',
  'overlay:volume':            (a) => a.length === 1 && typeof a[0] === 'number'
                                       && Number.isFinite(a[0]) && a[0] >= 0 && a[0] <= 100,
  'overlay:minimize':          (a) => a.length === 0,
  'overlay:maximize-toggle':   (a) => a.length === 0,
  'overlay:fullscreen-toggle': (a) => a.length === 0,
  'overlay:prev-channel':      (a) => a.length === 0,
  'overlay:next-channel':      (a) => a.length === 0,
  'overlay:cast':              (a) => a.length === 0,
};

const RECV_CHANNELS = new Set([
  'overlay:channel',
  'overlay:state',
  'overlay:window-state',
]);

contextBridge.exposeInMainWorld('overlayAPI', {
  send: (channel, ...args) => {
    const v = SEND_VALIDATORS[channel];
    if (!v || !v(args)) return; // unknown channel or bad args → silent drop
    ipcRenderer.send(channel, ...args);
  },
  on: (channel, cb) => {
    if (!RECV_CHANNELS.has(channel) || typeof cb !== 'function') return () => {};
    const handler = (_e, ...args) => { try { cb(...args); } catch (_) {} };
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
