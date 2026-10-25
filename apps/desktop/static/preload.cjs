/**
 * Sandboxed preload: the only bridge between pages and the app. Exposes the app version
 * and "retry now" for the unavailable screen. No Node, no IPC channels beyond this.
 */
const { contextBridge, ipcRenderer } = require('electron');

const versionArg = process.argv.find((arg) => arg.startsWith('--cl-version='));

contextBridge.exposeInMainWorld(
  'coffeeLounge',
  Object.freeze({
    version: versionArg ? versionArg.slice('--cl-version='.length) : 'unknown',
    retryNow: () => {
      ipcRenderer.send('cl:retry');
    },
  }),
);
