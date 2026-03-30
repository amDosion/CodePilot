import os from 'os';
import path from 'path';
import { getSession } from '@/lib/db';
import { isPathSafe, isRootPath } from '@/lib/files';

export class FileScopeError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getRequestedSessionId(searchParams: URLSearchParams): string {
  return (searchParams.get('session_id') || searchParams.get('sessionId') || '').trim();
}

export function resolveScopeBaseDir(searchParams: URLSearchParams): string | null {
  const sessionId = getRequestedSessionId(searchParams);
  if (sessionId) {
    const session = getSession(sessionId);
    if (!session) {
      throw new FileScopeError('Session not found', 404);
    }

    const workingDirectory = (session.sdk_cwd || session.working_directory || '').trim();
    if (!workingDirectory) {
      throw new FileScopeError('Session does not have a working directory', 400);
    }

    return path.resolve(workingDirectory);
  }

  const baseDir = (searchParams.get('baseDir') || '').trim();
  return baseDir ? path.resolve(baseDir) : null;
}

export function assertScopedPathAllowed(targetPath: string, searchParams: URLSearchParams, kind: 'file' | 'directory'): {
  resolvedPath: string;
  resolvedBaseDir: string;
} {
  const resolvedPath = path.resolve(targetPath);
  const baseDir = resolveScopeBaseDir(searchParams);

  if (baseDir) {
    if (isRootPath(baseDir)) {
      throw new FileScopeError('Cannot use filesystem root as base directory', 403);
    }
    if (!isPathSafe(baseDir, resolvedPath)) {
      throw new FileScopeError(
        kind === 'directory' ? 'Directory is outside the project scope' : 'File is outside the project scope',
        403,
      );
    }
    return { resolvedPath, resolvedBaseDir: baseDir };
  }

  const homeDir = path.resolve(os.homedir());
  if (!isPathSafe(homeDir, resolvedPath)) {
    throw new FileScopeError(
      kind === 'directory' ? 'Directory is outside the allowed scope' : 'File is outside the allowed scope',
      403,
    );
  }

  return { resolvedPath, resolvedBaseDir: homeDir };
}
