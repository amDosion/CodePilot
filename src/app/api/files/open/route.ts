import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/db';

interface OpenPathRequest {
  session_id?: unknown;
  sessionId?: unknown;
  baseDir?: unknown;
  path?: unknown;
}

function getRequestedSessionId(body: OpenPathRequest): string {
  if (typeof body.session_id === 'string' && body.session_id.trim()) {
    return body.session_id.trim();
  }
  if (typeof body.sessionId === 'string' && body.sessionId.trim()) {
    return body.sessionId.trim();
  }
  return '';
}

function getRequestedBaseDir(body: OpenPathRequest): string {
  if (typeof body.baseDir === 'string' && body.baseDir.trim()) {
    return body.baseDir.trim();
  }
  return '';
}

function getOpenCommand(targetPath: string): { command: string; args: string[] } {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [targetPath] };
  }
  if (process.platform === 'win32') {
    return { command: 'explorer', args: [targetPath] };
  }
  return { command: 'xdg-open', args: [targetPath] };
}

async function launchPath(targetPath: string): Promise<void> {
  const { command, args } = getOpenCommand(targetPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function POST(req: NextRequest) {
  let body: OpenPathRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const sessionId = getRequestedSessionId(body);
  const requestedBaseDir = getRequestedBaseDir(body);
  let workingDirectory = '';

  if (sessionId) {
    const session = getSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    workingDirectory = (session.sdk_cwd || session.working_directory || '').trim();
  } else {
    workingDirectory = requestedBaseDir;
  }

  if (!workingDirectory) {
    return NextResponse.json({ error: 'Missing working directory context' }, { status: 400 });
  }

  try {
    const resolvedRoot = await fs.realpath(workingDirectory);
    const stat = await fs.stat(resolvedRoot);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: 'Working directory is not a directory' }, { status: 400 });
    }

    let targetPath = resolvedRoot;
    if (typeof body.path === 'string' && body.path.trim()) {
      const requestedPath = await fs.realpath(body.path.trim());
      const relativePath = path.relative(resolvedRoot, requestedPath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return NextResponse.json({ error: 'Path must stay within the working directory' }, { status: 403 });
      }
      targetPath = requestedPath;
    }

    await launchPath(targetPath);
    return NextResponse.json({ ok: true, path: targetPath });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return NextResponse.json({ error: 'Path not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to open path' },
      { status: 500 },
    );
  }
}
