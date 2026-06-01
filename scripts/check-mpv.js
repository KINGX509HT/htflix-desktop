#!/usr/bin/env node
// ─── HTFLIX Desktop — mpv binary presence check ───────────────────────────
// Runs before electron-builder. For each platform that's about to be built,
// verifies that resources/mpv/<platform>-<arch>/mpv(.exe) exists. Fails the
// build with explicit instructions if any expected binary is missing, so we
// never ship a build that silently falls back to "mpv binary not found".

'use strict';

const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..');
const MPV_ROOT = path.join(ROOT, 'resources', 'mpv');

// Which platform-arch combos are bundled per electron-builder target.
// Keep in sync with the "build" block of package.json.
const TARGETS = {
  mac:   ['darwin-arm64'],
  win:   ['win32-x64', 'win32-ia32'],
  linux: ['linux-x64'],
};

// Where to obtain a portable mpv build for each platform.
const SOURCES = {
  'darwin-arm64': 'https://laboratory.stolendata.net/~djinn/mpv_osx/  (or `brew install mpv` and copy the binary + dylibs)',
  'darwin-x64':   'https://laboratory.stolendata.net/~djinn/mpv_osx/  (or `brew install mpv` and copy the binary + dylibs)',
  'win32-x64':    'https://sourceforge.net/projects/mpv-player-windows/files/64bit/  (shinchiro builds — extract mpv.exe and DLLs)',
  'win32-ia32':   'https://sourceforge.net/projects/mpv-player-windows/files/32bit/',
  'linux-x64':    'apt/dnf install mpv on the build host, or use the AppImage from https://mpv.io/',
};

function binaryName(platformArch) {
  return platformArch.startsWith('win32-') ? 'mpv.exe' : 'mpv';
}

function detectRequestedTargets() {
  // electron-builder passes --mac / --win / --linux as argv flags; if none
  // present, fall back to host platform.
  const argv = process.argv.slice(2);
  const want = new Set();
  if (argv.includes('--mac'))   want.add('mac');
  if (argv.includes('--win'))   want.add('win');
  if (argv.includes('--linux')) want.add('linux');
  if (want.size === 0) {
    if (process.platform === 'darwin') want.add('mac');
    else if (process.platform === 'win32') want.add('win');
    else want.add('linux');
  }
  return [...want];
}

function main() {
  const requested = detectRequestedTargets();
  const missing = [];

  for (const target of requested) {
    for (const platformArch of TARGETS[target]) {
      const bin = path.join(MPV_ROOT, platformArch, binaryName(platformArch));
      if (!fs.existsSync(bin)) {
        missing.push({ platformArch, bin });
      }
    }
  }

  if (missing.length === 0) {
    console.log('[check-mpv] all required mpv binaries present.');
    return;
  }

  console.error('');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(' BUILD ABORTED: missing mpv binaries');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const m of missing) {
    console.error('');
    console.error('  • ' + path.relative(ROOT, m.bin));
    console.error('    obtain from: ' + (SOURCES[m.platformArch] || '(no source documented)'));
  }
  console.error('');
  console.error('  Drop the platform-appropriate mpv binary (plus any shared');
  console.error('  libraries it depends on) into each directory above, then');
  console.error('  re-run the build. To skip a platform, omit its electron-');
  console.error('  builder flag (--win / --mac / --linux).');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('');
  process.exit(1);
}

main();
