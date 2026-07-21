// Native Windows toast notifications, gated by user-configurable toggles
// (Settings → Application → Notifications).
const { Notification, nativeImage } = require('electron');
const path = require('path');
const store = require('./store');
const logger = require('./logger');

let icon = null;
let focusFn = null;

function init(focus) {
  focusFn = focus;
  try {
    icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
    if (icon.isEmpty()) icon = null;
  } catch (_) { icon = null; }
}

// kind: 'onTradeOpened' | 'onTradeClosed' | 'onHalt' | 'onError' | null (always)
function show(kind, title, body) {
  try {
    const n = store.get().notifications;
    if (!n.enabled) return;
    if (kind && n[kind] === false) return;
    if (!Notification.isSupported()) return;
    const toast = new Notification({
      title,
      body: String(body || '').slice(0, 200),
      icon: icon || undefined
    });
    toast.on('click', () => { if (focusFn) focusFn(); });
    toast.show();
  } catch (e) {
    logger.debug('notify', 'toast failed: ' + e.message);
  }
}

module.exports = { init, show };
