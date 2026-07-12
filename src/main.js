// SkoolLink desktop shell — loads the production admin console and adds what a
// browser can't: tray residency (close = hide, not quit), a taskbar badge for
// unacknowledged route-change alerts (fed by the page via the preload bridge),
// launch-at-login, and GitHub-releases auto-update. All product features live
// in the web app; deploying the web app updates this shell's content instantly.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('path');

const APP_URL = 'https://skoollink-eosin.vercel.app';
const ASSETS = path.join(__dirname, '..', 'assets');

// Hosts allowed to load inside the app window/popups. Everything else opens in
// the default browser. Google OAuth must never stay inside Electron because
// Google rejects embedded user agents on managed/new Windows installs.
const INTERNAL_HOST_SUFFIXES = [
  'skoollink-eosin.vercel.app',
  'supabase.co',
  'kakao.com',
  'daum.net',
  'naver.com',
];

const EXTERNAL_AUTH_HOSTS = new Set([
  'accounts.google.com',
  'kauth.kakao.com',
  'nid.naver.com',
]);

function isInternalUrl(url) {
  try {
    const host = new URL(url).hostname;
    return INTERNAL_HOST_SUFFIXES.some(s => host === s || host.endsWith('.' + s));
  } catch {
    return false;
  }
}

let win = null;
let tray = null;
let isQuitting = false;

const startHidden = process.argv.includes('--hidden');

// Second launch (e.g. desktop icon while running in tray) surfaces the window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  // Google rejects OAuth from user agents that advertise an embedded shell
  // (disallowed_useragent) — present as plain Chrome.
  app.userAgentFallback = app.userAgentFallback
    .replace(/\sSkoolLink\/[\d.]+/i, '')
    .replace(/\sElectron\/[\d.]+/, '');

  app.whenReady().then(() => {
    // Must match build.appId or Windows toasts show no app name/icon.
    app.setAppUserModelId('kr.rosemont.skoollink');
    createWindow();
    createTray();
    setupAutoUpdate();
    ipcMain.on('skool:badge', (_e, n) => setBadge(Number(n) || 0));
    ipcMain.on('skool:show', () => showWindow());
    ipcMain.on('skool:open-external', (_e, url) => openExternalUrl(url));
  });

  app.on('before-quit', () => { isQuitting = true; });
}

function openExternalUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') return;
    if (!EXTERNAL_AUTH_HOSTS.has(parsed.hostname)) return;
    shell.openExternal(parsed.toString());
  } catch {
    // ignore malformed URLs from the page bridge
  }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: !startHidden,
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    icon: path.join(ASSETS, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
  });

  if (process.env.SKOOL_DEBUG) {
    win.webContents.on('did-navigate', (_e, url) => console.log('[nav]', url));
    win.webContents.on('did-navigate-in-page', (_e, url) => console.log('[nav-spa]', url));
  }

  win.loadURL(APP_URL);

  // Close = hide to tray (ChannelTalk behavior). Real quit is the tray menu.
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Tray residency keeps one SPA instance alive for days, so web deploys
  // wouldn't reach the app until a manual restart. Refresh after long hidden
  // stretches; a visible window is never interrupted (no draft loss, and the
  // live bus-tracking dashboard is never yanked out from under someone watching it).
  const RELOAD_AFTER_HIDDEN_MS = 4 * 60 * 60 * 1000;
  let hiddenAt = null;
  win.on('hide', () => { hiddenAt = Date.now(); });
  win.on('show', () => {
    if (hiddenAt && Date.now() - hiddenAt >= RELOAD_AFTER_HIDDEN_MS) win.webContents.reload();
    hiddenAt = null;
  });
  setInterval(() => {
    if (hiddenAt && Date.now() - hiddenAt >= 24 * 60 * 60 * 1000) {
      win.loadURL(APP_URL);
      hiddenAt = Date.now(); // re-arm: refresh again tomorrow if still hidden
    }
  }, 30 * 60 * 1000);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!isInternalUrl(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Network failure → local offline page (it retries APP_URL on its own).
  // -3 (ERR_ABORTED) fires on ordinary SPA navigation cancels; not a failure.
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      win.loadFile(path.join(__dirname, 'offline.html'));
    }
  });
}

// ── Taskbar unread badge ─────────────────────────────────────────────────────
// Windows has no Badging API; the web app sends its unacknowledged route-change
// count through the preload bridge and we pin a numbered overlay on the taskbar icon.
function setBadge(count) {
  if (!win) return;
  const n = Math.max(0, Math.floor(count));
  if (n > 0) {
    const name = n > 9 ? '9plus' : String(n);
    const icon = nativeImage.createFromPath(path.join(ASSETS, 'overlay', `overlay-${name}.png`));
    win.setOverlayIcon(icon, `노선변경 미확인 ${n}건`);
  } else {
    win.setOverlayIcon(null, '');
  }
  if (tray) tray.setToolTip(n > 0 ? `SkoolLink — 노선변경 미확인 ${n}건` : 'SkoolLink');
}

// ── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(path.join(ASSETS, 'tray.png'));
  tray.setToolTip('SkoolLink');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'SkoolLink 열기', click: showWindow },
    { type: 'separator' },
    {
      label: '시작 시 자동 실행',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      // --hidden: boot launches straight to tray instead of opening the window
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { label: '업데이트 확인', click: () => checkForUpdates() },
    { type: 'separator' },
    { label: '종료', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// ── Auto-update (GitHub Releases) ────────────────────────────────────────────
function checkForUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  // Downloads in the background, notifies, installs on quit.
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

function setupAutoUpdate() {
  checkForUpdates();
  setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
}
