// ─── HTFLIX Desktop — mpv sidecar controller ─────────────────────────────────
// Spawns mpv as a child process, talks to it over JSON IPC (Unix socket).
// mpv handles every codec the web can't: AC3, E-AC3, DTS, MPEG-TS, HEVC.

'use strict';

const { spawn } = require('child_process');
const net  = require('net');
const path = require('path');
const os   = require('os');
const fs   = require('fs');

function findMpvBinary() {
  const platformArch = process.platform + '-' + process.arch;
  const exe = process.platform === 'win32' ? 'mpv.exe' : 'mpv';

  // 1. Bundled in packaged app (extraResources)
  const packaged = path.join(process.resourcesPath || '', 'mpv', platformArch, exe);
  if (fs.existsSync(packaged)) return packaged;

  // 2. Bundled in dev (htflix-desktop/resources/mpv/<platform>-<arch>/mpv)
  const dev = path.join(__dirname, 'resources', 'mpv', platformArch, exe);
  if (fs.existsSync(dev)) return dev;

  // 3. System install fallback per platform
  if (process.platform === 'win32') {
    for (const p of [
      'C:\\Program Files\\mpv\\mpv.exe',
      'C:\\Program Files (x86)\\mpv\\mpv.exe',
    ]) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    for (const p of ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/usr/bin/mpv']) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function mpvInstallHint() {
  if (process.platform === 'win32') {
    return 'install mpv from https://mpv.io/installation/ and ensure mpv.exe is in C:\\Program Files\\mpv\\';
  }
  if (process.platform === 'darwin') return 'run: brew install mpv';
  return 'run: sudo apt install mpv (or your distro\'s equivalent)';
}

class MpvController {
  constructor() {
    this.bin = findMpvBinary();
    this.proc = null;
    this.client = null;
    this.sock = null;
    this.reqId = 0;
    this.pending = new Map();
    this.events = new Set();
  }

  available() { return !!this.bin; }
  onEvent(cb) { this.events.add(cb); return () => this.events.delete(cb); }

  async play(url, opts = {}) {
    if (!this.bin) throw new Error('mpv binary not found — ' + mpvInstallHint());
    await this.stop();

    // Web app may pass bounds as a nested object {bounds:{...}} or flat {x,y,w,h}
    const b = opts.bounds || opts;
    const haveGeometry =
      [b.x, b.y, b.width, b.height].every(v => typeof v === 'number' && isFinite(v));

    // Embed mode: mpv renders as a child HWND/NSView/XID of an Electron
    // BrowserWindow. Used on Windows where standalone mpv + transparent
    // overlay races against the DWM compositor. embedWid is the native
    // window handle (decimal string) of the parent BrowserWindow.
    const embed = typeof opts.embedWid === 'string' && opts.embedWid.length > 0;

    this.sock = path.join(os.tmpdir(), `htflix-mpv-${Date.now()}.sock`);

    const baseArgs = [
      '--input-ipc-server=' + this.sock,
      '--no-config',
      // Our overlay BrowserWindow draws every control — mpv is video only.
      '--osc=no',
      '--osd-bar=no',
      '--no-input-default-bindings',
      '--keep-open=no',
      '--idle=no',
      '--force-window=immediate',
      // Fill the entire player rectangle, edge-to-edge — preserve aspect
      // (no stretching), crop whichever dimension overflows. Netflix-style.
      '--keepaspect=yes',
      '--video-unscaled=no',
      '--panscan=1.0',
      '--title=HTFLIX External Player',
      '--user-agent=' + (opts.userAgent || 'VLC/3.0.20 LibVLC/3.0.20'),
      '--cache=yes',
      '--cache-secs=10',
      '--demuxer-max-bytes=80MiB',
      '--demuxer-max-back-bytes=40MiB',
      '--hwdec=auto-safe',
      '--aid=auto',
      '--ytdl=no',
      '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_on_http_error=4xx,5xx,reconnect_delay_max=5',
    ];

    const standaloneArgs = [
      // Standalone (macOS): mpv owns its own borderless window.
      '--no-border',
      '--ontop',
      // macOS-only: borderless covering current screen, NOT native-fs
      // (which would create a Space). On Windows these are no-ops/warnings.
      '--fs-screen=current',
      '--no-native-fs',
    ];

    const embedArgs = [
      // Embedded (Windows): mpv attaches as a child of the given window
      // handle, parent owns geometry/fullscreen/z-order.
      `--wid=${opts.embedWid}`,
      '--no-input-vo-keyboard',
    ];

    const args = [
      ...baseArgs,
      ...(embed ? embedArgs : standaloneArgs),
      url,
    ];

    if (!embed && haveGeometry) {
      // Standalone mpv window. Initial geometry seeds size in case the user
      // exits fullscreen later; --fullscreen at spawn forces edge-to-edge.
      const W = Math.max(160, Math.round(b.width));
      const H = Math.max(120, Math.round(b.height));
      const X = Math.round(b.x);
      const Y = Math.round(b.y);
      args.unshift(`--geometry=${W}x${H}+${X}+${Y}`);
    }
    if (!embed && opts.fullscreen) args.unshift('--fullscreen');

    console.log('[mpv] spawn', this.bin, args.map(a => a.length > 120 ? a.slice(0, 120) + '…' : a).join(' '));

    // Buffer last N stderr lines so we can include them in errors
    this._stderrTail = [];
    this.proc = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = (label) => (d) => {
      const s = d.toString();
      console.log(`[mpv:${label}]`, s.trim());
      this._stderrTail.push(s);
      if (this._stderrTail.length > 40) this._stderrTail.shift();
    };
    this.proc.stderr.on('data', tail('err'));
    this.proc.stdout.on('data', tail('out'));
    let exitInfo = null;
    this.proc.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      console.log('[mpv] exited', code, signal);
      this.proc = null; this.client = null;
      this.events.forEach(cb => cb({ event: 'end' }));
    });

    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const fail = (reason) => {
        const tail = (this._stderrTail || []).join('').trim().split('\n').slice(-8).join(' | ');
        reject(new Error(`${reason}${exitInfo ? ` (mpv exited ${exitInfo.code})` : ''}${tail ? ` — mpv: ${tail}` : ''}`));
      };
      (function tryConnect(self) {
        if (exitInfo) return fail('mpv exited before socket open');
        if (Date.now() - t0 > 15000) return fail('mpv socket timeout');
        if (!fs.existsSync(self.sock)) return setTimeout(() => tryConnect(self), 60);
        self.client = net.createConnection(self.sock);
        self.client.once('connect', () => {
          self.client.on('data', b => self._onData(b));
          self.client.on('error', () => {});
          resolve();
        });
        self.client.once('error', () => setTimeout(() => tryConnect(self), 60));
      })(this);
    });
  }

  _onData(buf) {
    for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.request_id != null && this.pending.has(m.request_id)) {
        const { resolve, reject } = this.pending.get(m.request_id);
        this.pending.delete(m.request_id);
        m.error === 'success' ? resolve(m.data) : reject(new Error(m.error));
      } else if (m.event) {
        this.events.forEach(cb => cb(m));
      }
    }
  }

  cmd(...args) {
    if (!this.client) return Promise.reject(new Error('mpv not running'));
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.client.write(JSON.stringify({ command: args, request_id: id }) + '\n');
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('mpv timeout'));
      }, 3000);
    });
  }

  pause()        { return this.cmd('set_property', 'pause', true); }
  resume()       { return this.cmd('set_property', 'pause', false); }
  togglePause()  { return this.cmd('cycle', 'pause'); }
  setVolume(v)   { return this.cmd('set_property', 'volume', Math.max(0, Math.min(100, v))); }
  mute(b)        { return this.cmd('set_property', 'mute', !!b); }
  setBounds({ x, y, width, height }) {
    return this.cmd('set_property', 'geometry',
      `${Math.round(width)}x${Math.round(height)}+${Math.round(x)}+${Math.round(y)}`);
  }
  fullscreen(b)  { return this.cmd('set_property', 'fullscreen', !!b); }
  minimize()     { return this.cmd('set_property', 'window-minimized', true); }
  unminimize()   { return this.cmd('set_property', 'window-minimized', false); }
  maximize(b)    { return this.cmd('set_property', 'window-maximized', !!b); }
  raise()        { return this.cmd('set_property', 'ontop', true); }

  async stop() {
    if (this.client) { try { this.client.end(); } catch {} this.client = null; }
    if (this.proc)   { try { this.proc.kill('SIGTERM'); } catch {} this.proc = null; }
    if (this.sock && fs.existsSync(this.sock)) { try { fs.unlinkSync(this.sock); } catch {} }
  }
}

module.exports = { MpvController, findMpvBinary, mpvInstallHint };
