// Auto-update via electron-updater with a user-configurable "generic" feed:
// point Settings → Updates at any static HTTPS folder that hosts the files
// electron-builder produces (latest.yml + the Setup .exe) and updates flow
// automatically. No feed URL = the updater stays completely idle.
const { app } = require('electron');
const store = require('./store');
const logger = require('./logger');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) { /* dependency missing; updater stays disabled */ }

let push = () => {};
let state = { state: 'idle' };

function setState(s) {
  state = s;
  push(s);
}

// Default source is the GitHub repo baked into app-update.yml at build time
// (from build.publish in package.json). A non-empty feedUrl is an optional
// override for self-hosting on any static HTTPS folder.
function configureFeed() {
  const url = (store.get().updates.feedUrl || '').trim();
  if (url) {
    autoUpdater.setFeedURL({ provider: 'generic', url });
    return 'generic';
  }
  return 'github';
}

function init(pushFn) {
  push = pushFn;
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => {
    logger.info('updater', 'update available: ' + info.version);
    setState({ state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => setState({ state: 'uptodate', current: app.getVersion() }));
  autoUpdater.on('download-progress', (p) => setState({ state: 'downloading', pct: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    logger.info('updater', 'update downloaded: ' + info.version);
    setState({ state: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (e) => {
    logger.warn('updater', 'update error: ' + e.message);
    setState({ state: 'error', msg: e.message });
  });

  const autoCheck = () => {
    if (!store.get().updates.auto) return;
    check().catch(() => { /* logged via error event */ });
  };
  if (app.isPackaged) {
    setTimeout(autoCheck, 15000);
    setInterval(autoCheck, 4 * 3600 * 1000).unref();
  }
}

async function check() {
  if (!autoUpdater) throw new Error('Updater module not available');
  if (!app.isPackaged) throw new Error('Updates only work in the packaged app (not dev mode)');
  configureFeed();
  setState({ state: 'checking' });
  await autoUpdater.checkForUpdates();
  return state;
}

function install() {
  if (!autoUpdater) throw new Error('Updater module not available');
  autoUpdater.quitAndInstall();
}

function getState() {
  return { ...state, current: app.getVersion() };
}

module.exports = { init, check, install, getState };
