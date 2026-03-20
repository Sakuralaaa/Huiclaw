import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from './contracts';

const bridge: DesktopBridge = {
  getBootstrap: () => ipcRenderer.invoke('bridge:get-bootstrap'),
  runtime: {
    start: () => ipcRenderer.invoke('runtime:start'),
    stop: () => ipcRenderer.invoke('runtime:stop'),
    restart: () => ipcRenderer.invoke('runtime:restart'),
    status: () => ipcRenderer.invoke('runtime:status'),
  },
  desktopApi: {
    getSummary: () => ipcRenderer.invoke('desktop:get-summary'),
    getConfig: () => ipcRenderer.invoke('desktop:get-config'),
    saveConfig: (config) => ipcRenderer.invoke('desktop:save-config', config),
  },
  envApi: {
    detect: () => ipcRenderer.invoke('env:detect'),
    setPythonPath: (pythonPath) => ipcRenderer.invoke('env:set-python-path', pythonPath),
    installDependencies: () => ipcRenderer.invoke('env:install-dependencies'),
    updateDependencies: () => ipcRenderer.invoke('env:update-dependencies'),
  },
  logs: {
    subscribe: (callback) => {
      const listener = (_event: unknown, line: string) => callback(line);
      ipcRenderer.on('runtime:log-line', listener);
      return () => ipcRenderer.removeListener('runtime:log-line', listener);
    },
  },
  openPath: (target) => ipcRenderer.invoke('shell:open-path', target),
};

contextBridge.exposeInMainWorld('myclaw', bridge);

