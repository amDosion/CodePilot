import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { assertScopedPathAllowed, FileScopeError } from '@/lib/file-scope';
import { isPathSafe } from '@/lib/files';
import type { ErrorResponse, FileUploadResponse, UploadErrorEntry, UploadedFileEntry } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

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

function buildScopeSearchParams(formData: FormData): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ['session_id', 'sessionId', 'baseDir']) {
    const value = formData.get(key);
    if (typeof value === 'string' && value.trim()) {
      params.set(key, value.trim());
    }
  }
  return params;
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

async function writeUploadedFile(file: File, destinationPath: string): Promise<void> {
  const arrayBuffer = await file.arrayBuffer();
  await fs.writeFile(destinationPath, Buffer.from(arrayBuffer));
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files').filter((value): value is File => value instanceof File);
    const targetDir = (formData.get('target_dir') || '').toString().trim();
    const overwrite = parseBoolean(formData.get('overwrite'));
    const relativePaths = formData.getAll('relative_paths').map((value) => value.toString());

    if (!targetDir) {
      return NextResponse.json<ErrorResponse>({ error: 'target_dir is required' }, { status: 400 });
    }
    if (files.length === 0) {
      return NextResponse.json<ErrorResponse>({ error: 'At least one file is required' }, { status: 400 });
    }

    const searchParams = buildScopeSearchParams(formData);
    const { resolvedPath: scopedTargetDir } = assertScopedPathAllowed(targetDir, searchParams, 'directory');
    if (hasSensitivePathSegments(scopedTargetDir)) {
      return NextResponse.json<ErrorResponse>({ error: 'Uploading to sensitive paths is not allowed' }, { status: 403 });
    }
    await fs.mkdir(scopedTargetDir, { recursive: true });

    const uploaded: UploadedFileEntry[] = [];
    const errors: UploadErrorEntry[] = [];

    for (const [index, file] of files.entries()) {
      const fallbackName = path.basename(file.name || `upload-${index + 1}`);
      try {
        if (file.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`File exceeds ${MAX_FILE_SIZE_BYTES} byte limit`);
        }

        const relativePath = sanitizeRelativeUploadPath(relativePaths[index] || fallbackName, fallbackName);
        const destinationPath = path.resolve(path.join(scopedTargetDir, relativePath));
        if (!isPathSafe(scopedTargetDir, destinationPath)) {
          throw new Error('Upload destination escapes the target directory');
        }

        await fs.mkdir(path.dirname(destinationPath), { recursive: true });

        let overwritten = false;
        try {
          await fs.access(destinationPath);
          if (!overwrite) {
            throw new Error(`File already exists: ${relativePath}`);
          }
          overwritten = true;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('File already exists:')) {
            throw error;
          }
        }

        await writeUploadedFile(file, destinationPath);
        uploaded.push({
          name: file.name || fallbackName,
          path: destinationPath,
          size: file.size,
          overwritten,
        });
      } catch (error) {
        errors.push({
          name: file.name || fallbackName,
          error: error instanceof Error ? error.message : 'Upload failed',
        });
      }
    }

    return NextResponse.json<FileUploadResponse>({ uploaded, errors });
  } catch (error) {
    if (error instanceof FileScopeError) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to upload files' },
      { status: 500 },
    );
  }
}
