// SkoolLink desktop shell — loads the production admin console and adds what a
// browser can't: tray residency (close = hide, not quit), a taskbar badge for
// unacknowledged route-change alerts (fed by the page via the preload bridge),
// launch-at-login, and GitHub-releases auto-update. All product features live
// in the web app; deploying the web app updates this shell's content instantly.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('path');

const APP_URL = 'https://skoollink-eosin.vercel.app';
const ASSETS = path.join(__dirname, '..', 'assets');

// 신청알림 등에서 앱으로 바로 여는 딥링크 스킴. skoollink://admin/dashboard?day=3&q=이름
// → https://skoollink-eosin.vercel.app/admin/dashboard?day=3&q=이름 으로 열어준다.
const DEEP_LINK_SCHEME = 'skoollink';

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
// 창이 생기기 전에 도착한 딥링크(콜드 스타트·macOS open-url)를 버퍼링했다가 창이 뜨면 연다.
let pendingDeepLink = null;

const startHidden = process.argv.includes('--hidden');

// macOS는 딥링크가 open-url 이벤트로 온다(앱이 꺼져 있으면 whenReady 이전에 올 수도 있어
// 락 획득 여부와 무관하게 바깥에서 먼저 등록한다).
app.on('open-url', (e, url) => {
  e.preventDefault();
  handleDeepLink(url);
});

// Second launch (e.g. desktop icon while running in tray) surfaces the window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 앱이 이미 떠 있는데 두 번째 실행(딥링크 클릭·바로가기)되면 Windows/Linux는 그 argv로
  // skoollink:// URL이 넘어온다 — 집어서 처리하고 창을 띄운다.
  app.on('second-instance', (_e, argv) => {
    const link = argv.find(a => typeof a === 'string' && a.toLowerCase().startsWith(DEEP_LINK_SCHEME + '://'));
    if (link) handleDeepLink(link);
    showWindow();
  });

  // Google rejects OAuth from user agents that advertise an embedded shell
  // (disallowed_useragent) — present as plain Chrome.
  app.userAgentFallback = app.userAgentFallback
    .replace(/\sSkoolLink\/[\d.]+/i, '')
    .replace(/\sElectron\/[\d.]+/, '');

  app.whenReady().then(() => {
    registerDeepLinkClient();
    // Windows 전용 — 다른 OS에선 no-op이라 무해하지만 명시적으로 가둔다.
    if (process.platform === 'win32') app.setAppUserModelId('kr.rosemont.skoollink');
    // 콜드 스타트가 딥링크로 시작된 경우(Windows/Linux) launch argv에서 집어낸다.
    const launchLink = process.argv.find(a => typeof a === 'string' && a.toLowerCase().startsWith(DEEP_LINK_SCHEME + '://'));
    if (launchLink) handleDeepLink(launchLink);
    createWindow();
    createTray();
    setupAutoUpdate();
    ipcMain.on('skool:badge', (_e, n) => setBadge(Number(n) || 0));
    ipcMain.on('skool:show', () => showWindow());
    ipcMain.on('skool:open-external', (_e, url) => openExternalUrl(url));
  });

  app.on('before-quit', () => { isQuitting = true; });
  // macOS: 독 아이콘 클릭 시 트레이/독에 숨어 있던 창을 다시 띄운다.
  app.on('activate', () => showWindow());
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

// OS에 skoollink:// 스킴 핸들러로 등록한다(설치 시 electron-builder의 build.protocols가
// 기본 등록하지만, 개발 실행·재확정을 위해 런타임에서도 등록).
function registerDeepLinkClient() {
  try {
    if (process.defaultApp) {
      // electron으로 직접 실행하는 개발 모드: 스킴을 이 스크립트로 연결하려면 실행 경로+엔트리를 넘긴다.
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
      }
    } else {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    }
  } catch { /* 등록 실패해도 앱 구동엔 지장 없음 */ }
}

// skoollink://admin/dashboard?day=3&q=이름  →  APP_URL/admin/dashboard?day=3&q=이름 로 이동.
// 스킴 뒤 경로·쿼리만 우리 도메인에 그대로 이어붙이므로 항상 앱 자신의 origin 안에 머문다.
function handleDeepLink(url) {
  if (typeof url !== 'string') return;
  const prefix = DEEP_LINK_SCHEME + '://';
  if (!url.toLowerCase().startsWith(prefix)) return;
  const rest = url.slice(prefix.length).replace(/^\/+/, ''); // "admin/dashboard?day=3&q=…"
  const target = `${APP_URL}/${rest}`;
  if (!win) { pendingDeepLink = target; return; } // 창 생성 전이면 버퍼링 → createWindow에서 로드
  win.loadURL(target);
  showWindow();
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

  // 딥링크로 켜졌으면 그 대상 URL을 바로 연다(없으면 대시보드 루트).
  win.loadURL(pendingDeepLink || APP_URL);
  pendingDeepLink = null;

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

// ── Unread badge ─────────────────────────────────────────────────────────────
// 웹 앱이 미확인 노선변경 건수를 preload 브릿지로 넘겨주면 배지로 표시한다.
//  · Windows: Badging API가 없어 작업표시줄 아이콘에 숫자 오버레이 png를 얹는다(창 필요).
//  · macOS: 독 아이콘에 숫자 배지를 찍는다(창이 숨어 있어도 동작).
function setBadge(count) {
  const n = Math.max(0, Math.floor(count || 0));
  if (process.platform === 'darwin') {
    if (app.dock) app.dock.setBadge(n > 0 ? String(n) : '');
  } else if (win) {
    if (n > 0) {
      const name = n > 9 ? '9plus' : String(n);
      const icon = nativeImage.createFromPath(path.join(ASSETS, 'overlay', `overlay-${name}.png`));
      win.setOverlayIcon(icon, `노선변경 미확인 ${n}건`);
    } else {
      win.setOverlayIcon(null, '');
    }
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
