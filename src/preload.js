// Bridge exposed to the SkoolLink web app. The page feature-detects it:
// `window.skoolDesktop?.setBadge(count)` — absent in browsers/PWA, so the
// web app needs no knowledge of Electron beyond this optional call.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skoolDesktop', {
  shell: 'electron',
  setBadge: (count) => ipcRenderer.send('skool:badge', count),
  openExternal: (url) => ipcRenderer.send('skool:open-external', url),
  // Notification click: surface the window even when hidden in the tray
  // (window.focus() can't un-hide a tray-resident window).
  showWindow: () => ipcRenderer.send('skool:show'),
});
