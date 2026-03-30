import { NextRequest, NextResponse } from 'next/server';
import { readFilePreview } from '@/lib/files';
import { assertScopedPathAllowed, FileScopeError } from '@/lib/file-scope';
import type { FilePreviewResponse, ErrorResponse } from '@/types';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const filePath = searchParams.get('path');
  const maxLines = parseInt(searchParams.get('maxLines') || '200', 10);

  if (!filePath) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Missing path parameter' },
      { status: 400 }
    );
  }

  try {
    const { resolvedPath } = assertScopedPathAllowed(filePath, searchParams, 'file');
    const preview = await readFilePreview(resolvedPath, Math.min(maxLines, 1000));
    return NextResponse.json<FilePreviewResponse>({ preview });
  } catch (error) {
    if (error instanceof FileScopeError) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to read file' },
      { status: 500 }
    );
  }
}
