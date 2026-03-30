import { NextRequest, NextResponse } from 'next/server';
import { scanDirectory } from '@/lib/files';
import { assertScopedPathAllowed, FileScopeError, resolveScopeBaseDir } from '@/lib/file-scope';
import type { FileTreeResponse, ErrorResponse } from '@/types';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const requestedDir = (searchParams.get('dir') || '').trim();
  const depth = parseInt(searchParams.get('depth') || '3', 10);

  try {
    const scopedBaseDir = resolveScopeBaseDir(searchParams);
    const targetDir = requestedDir || scopedBaseDir;

    if (!targetDir) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Missing dir parameter or session scope' },
        { status: 400 }
      );
    }

    const { resolvedPath } = assertScopedPathAllowed(targetDir, searchParams, 'directory');
    const tree = await scanDirectory(resolvedPath, Math.min(depth, 5));
    return NextResponse.json<FileTreeResponse>({ tree, root: resolvedPath });
  } catch (error) {
    if (error instanceof FileScopeError) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to scan directory' },
      { status: 500 }
    );
  }
}
