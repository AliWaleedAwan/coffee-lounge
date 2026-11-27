/**
 * Sandboxed preload: the only bridge between pages and the app. Exposes the app version
 * and "retry now" for the unavailable screen, and to that local screen alone, never to
 * server pages, the status of the services. No Node, no IPC channels beyond this.
 */
/* global window */
const { contextBridge, ipcRenderer } = require('electron');

const versionArg = process.argv.find((arg) => arg.startsWith('--cl-version='));

contextBridge.exposeInMainWorld(
  'coffeeLounge',
  Object.freeze({
    version: versionArg ? versionArg.slice('--cl-version='.length) : 'unknown',
    retryNow: () => {
      ipcRenderer.send('cl:retry');
    },
    ...(window.location.protocol === 'file:'
      ? {
          onServices: (listener) => {
            ipcRenderer.on('cl:services', (_event, rows) => {
              listener(rows);
            });
          },
        }
      : {}),
  }),
);
