// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
  shell: {
    openPath: (folderPath: string) => ipcRenderer.invoke('shell:open-path', folderPath),
    openExternal: (targetUrl: string) => ipcRenderer.invoke('shell:open-external', targetUrl),
  },
  dialog: {
    openFolder: (options?: { defaultPath?: string; title?: string }) =>
      ipcRenderer.invoke('dialog:open-folder', options),
  },
  install: {
    checkPrerequisites: () => ipcRenderer.invoke('install:check-prerequisites'),
    start: (options?: { includeNode?: boolean }) => ipcRenderer.invoke('install:start', options),
    cancel: () => ipcRenderer.invoke('install:cancel'),
    getLogs: () => ipcRenderer.invoke('install:get-logs'),
    onProgress: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('install:progress', listener);
      return () => { ipcRenderer.removeListener('install:progress', listener); };
    },
  },
  bridge: {
    isActive: () => ipcRenderer.invoke('bridge:is-active'),
  },
  githubAuth: {
    getSession: () => ipcRenderer.invoke('github:get-session'),
    storeSession: (session: unknown) => ipcRenderer.invoke('github:store-session', session),
    clearSession: () => ipcRenderer.invoke('github:clear-session'),
    cloneRepository: (input: { repositoryUrl: string; destination: string }) =>
      ipcRenderer.invoke('github:clone-repository', input),
    onCloneProgress: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('github:clone-progress', listener);
      return () => { ipcRenderer.removeListener('github:clone-progress', listener); };
    },
  },
});
