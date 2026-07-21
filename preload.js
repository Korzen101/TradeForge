const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = [
  'settings:get', 'settings:update', 'settings:reset', 'secrets:set',
  'settings:exportFile', 'settings:importFile', 'support:bundle',
  'conn:test', 'account:get', 'account:history', 'positions:get', 'clock:get',
  'position:close', 'positions:closeAll',
  'watchlist:validate', 'snapshots:get',
  'strategies:list',
  'engine:start', 'engine:stop', 'engine:status', 'logs:get',
  'trades:list', 'trades:stats', 'trades:clear', 'trades:export', 'trades:note',
  'scanner:get', 'news:get',
  'email:test', 'email:summaryNow',
  'backtest:run', 'backtest:cancel', 'backtest:export',
  'update:check', 'update:install', 'update:state',
  'readiness:get',
  'app:openExternal', 'app:openData', 'app:openLogs', 'app:version'
];

contextBridge.exposeInMainWorld('tf', {
  invoke: (channel, payload) => {
    if (!CHANNELS.includes(channel)) {
      return Promise.resolve({ ok: false, error: 'Unknown channel: ' + channel });
    }
    return ipcRenderer.invoke(channel, payload);
  },
  onPush: (cb) => {
    ipcRenderer.on('push', (_event, msg) => cb(msg));
  }
});
