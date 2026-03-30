import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import {
  assertRemotePathWithinRoot,
  ensureRemoteDirectory,
  uploadRemoteFileAtomic,
} from '@/lib/remote-ssh';
import type { ErrorResponse, FileUploadResponse, UploadErrorEntry, UploadedFileEntry } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

function isSensitivePathSegment(segment: string): boolean {
  return (
    segment === '.git'
    || segment === '.ssh'
    || segment.startsWith('.env')
    || ['authorized_keys', 'known_hosts', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'].includes(segment)
  );
}

function hasSensitivePathSegments(candidatePath: string): boolean {
  return candidatePath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .some(isSensitivePathSegment);
}

function parseBoolean(value: FormDataEntryValue | null): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

function sanitizeRelativeUploadPath(relativePath: string, fallbackName: string): string {
  const candidate = (relativePath || fallbackName).trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = candidate.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Upload path is empty');
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Upload path contains invalid traversal segments');
  }
  if (segments.some(isSensitivePathSegment)) {
    throw new Error('Uploading to sensitive paths is not allowed');
  }
  return segments.join('/');
}

async function writeTempFile(file: File, targetPath: string): Promise<void> {
  const arrayBuffer = await file.arrayBuffer();
  await fs.writeFile(targetPath, Buffer.from(arrayBuffer));
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files').filter((value): value is File => value instanceof File);
    const relativePaths = formData.getAll('relative_paths').map((value) => value.toString());
    const connectionId = (formData.get('connection_id') || '').toString().trim();
    const targetDir = (formData.get('target_dir') || '').toString().trim();
    const overwrite = parseBoolean(formData.get('overwrite'));

    if (!connectionId) {
      return NextResponse.json<ErrorResponse>({ error: 'connection_id is required' }, { status: 400 });
    }
    if (!targetDir) {
      return NextResponse.json<ErrorResponse>({ error: 'target_dir is required' }, { status: 400 });
    }
    if (files.length === 0) {
      return NextResponse.json<ErrorResponse>({ error: 'At least one file is required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json<ErrorResponse>({ error: 'Remote connection not found' }, { status: 404 });
    }

    const scopedTargetDir = assertRemotePathWithinRoot(connection, targetDir);
    if (hasSensitivePathSegments(scopedTargetDir)) {
      return NextResponse.json<ErrorResponse>({ error: 'Uploading to sensitive paths is not allowed' }, { status: 403 });
    }
    await ensureRemoteDirectory(connection, scopedTargetDir);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codepilot-remote-upload-'));
    const uploaded: UploadedFileEntry[] = [];
    const errors: UploadErrorEntry[] = [];

    try {
      for (const [index, file] of files.entries()) {
        const fallbackName = path.basename(file.name || `upload-${index + 1}`);
        try {
          if (file.size > MAX_FILE_SIZE_BYTES) {
            throw new Error(`File exceeds ${MAX_FILE_SIZE_BYTES} byte limit`);
          }

          const relativePath = sanitizeRelativeUploadPath(relativePaths[index] || fallbackName, fallbackName);
          const localTempPath = path.join(tempDir, `${index}-${fallbackName}`);
          const remoteDestination = path.posix.join(scopedTargetDir, relativePath);

          await fs.mkdir(path.dirname(localTempPath), { recursive: true });
          await writeTempFile(file, localTempPath);
          const uploadResult = await uploadRemoteFileAtomic(connection, localTempPath, remoteDestination, { overwrite });

          uploaded.push({
            name: file.name || fallbackName,
            path: remoteDestination,
            size: file.size,
            overwritten: uploadResult.overwritten,
          });
        } catch (error) {
          errors.push({
            name: file.name || fallbackName,
            error: error instanceof Error ? error.message : 'Remote upload failed',
          });
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    return NextResponse.json<FileUploadResponse>({ uploaded, errors });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to upload remote files' },
      { status: 500 },
    );
  }
}
