import type {
  GitHubAuthSession,
  GitHubAuthSessionSummary,
  GitHubCloneProgressEvent,
  GitHubCloneResult,
} from './index';

/**
 * Global type declarations for the Electron preload API.
 * Exposed via contextBridge.exposeInMainWorld('electronAPI', ...) in electron/preload.ts.
 */

interface ElectronInstallAPI {
  checkPrerequisites: () => Promise<{
    hasNode: boolean;
    nodeVersion?: string;
    hasClaude: boolean;
    claudeVersion?: string;
  }>;
  start: (options?: { includeNode?: boolean }) => Promise<void>;
  cancel: () => Promise<void>;
  getLogs: () => Promise<string[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onProgress: (callback: (data: any) => void) => () => void;
}

interface UpdateStatusEvent {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  info?: {
    version: string;
    releaseNotes?: string | { version: string; note: string }[] | null;
    releaseName?: string | null;
    releaseDate?: string;
  };
  progress?: {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  };
  error?: string;
}

interface ElectronUpdaterAPI {
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: () => Promise<void>;
  onStatus: (callback: (data: UpdateStatusEvent) => void) => () => void;
}

interface ElectronAPI {
  versions: {
    electron: string;
    node: string;
    chrome: string;
  };
  shell: {
    openPath: (path: string) => Promise<string>;
    openExternal: (url: string) => Promise<void>;
  };
  dialog: {
    openFolder: (options?: {
      defaultPath?: string;
      title?: string;
    }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  install: ElectronInstallAPI;
  bridge: {
    isActive: () => Promise<boolean>;
  };
  githubAuth?: {
    getSession: () => Promise<GitHubAuthSessionSummary>;
    storeSession: (session: GitHubAuthSession) => Promise<GitHubAuthSessionSummary>;
    clearSession: () => Promise<GitHubAuthSessionSummary>;
    cloneRepository: (input: { repositoryUrl: string; destination: string }) => Promise<GitHubCloneResult>;
    onCloneProgress: (callback: (data: GitHubCloneProgressEvent) => void) => () => void;
  };
  updater?: ElectronUpdaterAPI;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
