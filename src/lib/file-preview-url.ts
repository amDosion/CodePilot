interface BuildFilePreviewUrlOptions {
  filePath: string;
  workspaceMode: 'local' | 'remote';
  remoteConnectionId?: string | null;
  sessionId?: string | null;
  workingDirectory?: string | null;
  maxLines?: number;
}

export function buildFilePreviewUrl(options: BuildFilePreviewUrlOptions): string {
  const params = new URLSearchParams({ path: options.filePath });

  if (typeof options.maxLines === 'number' && Number.isFinite(options.maxLines)) {
    params.set('maxLines', String(options.maxLines));
  }

  if (options.workspaceMode === 'remote' && options.remoteConnectionId) {
    params.set('connection_id', options.remoteConnectionId);
    return `/api/remote/files/preview?${params.toString()}`;
  }

  if (options.sessionId) {
    params.set('session_id', options.sessionId);
  } else if (options.workingDirectory) {
    params.set('baseDir', options.workingDirectory);
  }

  return `/api/files/preview?${params.toString()}`;
}
