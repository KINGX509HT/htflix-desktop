# HTFLIX Desktop

Windows & Mac desktop app for HTFLIX. Built with Electron — the same technology used by Slack, Notion, VS Code, and Figma.

## Features

- Full HTFLIX app in a native desktop window
- **Network-level ad blocking** — ads blocked before the request even fires (mirrors iOS `onShouldStartLoadWithRequest`)
- **JavaScript-level ad blocking** — injected into every frame including VidLink's sub-player iframes (mirrors `injectedJavaScriptForMainFrameOnly={false}`)
- Popup/new-window deny — no popunders, no redirect tabs ever
- Window size/position memory — opens where you left it
- Native dark mode, native menus, keyboard shortcuts
- Auto-update support (when deploy URL is configured)

---

## Setup

### 1. Set your HTFLIX URL

Open `config.json` and replace `YOUR_DEPLOYED_URL` with your actual Replit deployment URL:

```json
{
  "htflixUrl": "https://your-actual-app.replit.app"
}
```

You can also set it via environment variable: `HTFLIX_URL=https://...`

### 2. Install dependencies

```bash
cd htflix-desktop
npm install
```

### 3. Run in development

```bash
npm start
```

This opens the desktop app in development mode pointing at your HTFLIX URL.

---

## Building for Distribution

### Windows (.exe installer)

Run on a Windows machine or use GitHub Actions/CI:

```bash
npm run dist:win
```

Produces `dist-build/HTFLIX Setup 1.0.0.exe`

### macOS (.dmg)

Run on a Mac:

```bash
npm run dist:mac
```

Produces `dist-build/HTFLIX-1.0.0.dmg` (Intel) and `dist-build/HTFLIX-1.0.0-arm64.dmg` (Apple Silicon)

### Linux (.AppImage)

```bash
npm run dist:linux
```

### All platforms

```bash
npm run dist
```

---

## App Icons

Place your icons in the `build/` folder:

| File | Platform | Size |
|------|----------|------|
| `build/icon.ico` | Windows | 256×256 (multi-size ICO) |
| `build/icon.icns` | macOS | 512×512 (ICNS format) |
| `build/icon.png` | Linux | 512×512 PNG |

You can convert your HTFLIX logo using online tools like convertio.co or favicon.io.

---

## Configuration Options (`config.json`)

| Key | Default | Description |
|-----|---------|-------------|
| `htflixUrl` | `"https://YOUR_DEPLOYED_URL.replit.app"` | The deployed HTFLIX web app URL |
| `windowWidth` | `1440` | Default window width |
| `windowHeight` | `900` | Default window height |
| `minWidth` | `1024` | Minimum window width |
| `minHeight` | `640` | Minimum window height |
| `rememberWindowSize` | `true` | Restore window size on relaunch |
| `rememberWindowPosition` | `true` | Restore window position on relaunch |
| `hardwareAcceleration` | `true` | Enable GPU acceleration |
| `autoHideMenuBar` | `false` | Auto-hide the menu bar (Windows/Linux) |
| `startMaximized` | `false` | Start the app maximized |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + H` | Go to HTFLIX home |
| `Cmd/Ctrl + R` | Reload page |
| `Cmd/Ctrl + Shift + R` | Force reload (ignore cache) |
| `Cmd/Ctrl + =` | Zoom in |
| `Cmd/Ctrl + -` | Zoom out |
| `Cmd/Ctrl + 0` | Reset zoom |
| `Cmd/Ctrl + ←` | Go back |
| `Cmd/Ctrl + →` | Go forward |
| `F11` / `Cmd + Ctrl + F` | Toggle fullscreen |

---

## How the Ad Blocking Works

The desktop app uses two layers of ad blocking — identical to the iOS mobile app:

### Layer 1 — Network (Electron equivalent of iOS `onShouldStartLoadWithRequest`)
```
session.webRequest.onBeforeRequest → cancels any request whose host matches the ad domain pattern
```
This runs at the OS level before any data is downloaded.

### Layer 2 — JavaScript (Electron equivalent of iOS `injectedJavaScriptForMainFrameOnly={false}`)
```
ad-blocker.js is injected into EVERY frame (main + all iframes) on dom-ready
```
This patches `window.open`, `fetch`, `XMLHttpRequest`, `history.pushState`, `location.href`, `Node.appendChild`, click handlers, and runs a periodic DOM sweep — the same 12-section ad blocking system as the iOS app.

---

## Distribution

Share the built installer files (`dist-build/`) through:
- Your website
- GitHub Releases
- Any file-sharing service

Users download and install like any normal app. No App Store required.
