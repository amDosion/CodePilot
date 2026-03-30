import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import { getFileLanguageForPath, isProbablyBinary } from '@/lib/files';
import { assertRemotePathWithinRoot, quoteShellArg, runRemoteCommand } from '@/lib/remote-ssh';
import type { ErrorResponse, FilePreviewResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const META_MARKER = '__CODEPILOT_REMOTE_PREVIEW_META__';
const ERROR_MARKER = '__CODEPILOT_REMOTE_PREVIEW_ERROR__';

function buildRemotePreviewMetadataScript(filePath: string): string {
  return [
    `FILE=${quoteShellArg(filePath)}`,
    'if [ ! -e "$FILE" ]; then',
    `  printf '${ERROR_MARKER}\\nmissing\\n'`,
    '  exit 0',
    'fi',
    'if [ ! -f "$FILE" ]; then',
    `  printf '${ERROR_MARKER}\\nnot_file\\n'`,
    '  exit 0',
    'fi',
    'TOTAL_BYTES=$(wc -c < "$FILE" | tr -d "[:space:]")',
    `printf '${META_MARKER}\\n'`,
    'printf "total_bytes=%s\\n" "$TOTAL_BYTES"',
    'printf "sample_base64=%s\\n" "$(head -c 4096 "$FILE" 2>/dev/null | base64 | tr -d \'\\n\')"',
  ].join('\n');
}

function buildRemotePreviewContentScript(filePath: string, maxLines: number): string {
  return [
    `FILE=${quoteShellArg(filePath)}`,
    `sed -n '1,${maxLines + 1}p' "$FILE"`,
  ].join('\n');
}

function parseRemotePreviewError(stdout: string, filePath: string): null | never {
  if (stdout.startsWith(`${ERROR_MARKER}\n`)) {
    const code = stdout.slice(ERROR_MARKER.length + 1).trim();
    if (code === 'missing') {
      throw new Error(`File not found: ${filePath}`);
    }
    if (code === 'not_file') {
      throw new Error(`Not a file: ${filePath}`);
    }
    throw new Error(`Failed to read file: ${filePath}`);
  }
  return null;
}

function parseRemotePreviewMetadata(stdout: string, filePath: string) {
  parseRemotePreviewError(stdout, filePath);

  const metaStart = stdout.indexOf(`${META_MARKER}\n`);
  if (metaStart === -1) {
    throw new Error('Invalid remote preview response');
  }

  const metaBlock = stdout
    .slice(metaStart + META_MARKER.length + 1)
    .trim();
  const meta = new Map<string, string>();

  for (const line of metaBlock.split('\n')) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;
    meta.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1));
  }

  return {
    totalBytes: Number.parseInt(meta.get('total_bytes') || '0', 10) || 0,
    sample: meta.get('sample_base64')
      ? Buffer.from(meta.get('sample_base64') as string, 'base64')
      : Buffer.alloc(0),
  };
}

function buildTextPreview(contentBlock: string, filePath: string, maxLines: number, totalBytes: number) {
  const normalized = contentBlock.endsWith('\n')
    ? contentBlock.slice(0, -1)
    : contentBlock;
  const lines = normalized.length > 0 ? normalized.split('\n') : [];
  const truncated = lines.length > maxLines;
  const visibleLines = truncated ? lines.slice(0, maxLines) : lines;
  return {
    path: filePath,
    content: visibleLines.join('\n'),
    language: getFileLanguageForPath(filePath),
    line_count: truncated ? visibleLines.length + 1 : visibleLines.length,
    truncated,
    binary: false,
    total_bytes: totalBytes,
  };
}

export async function GET(request: NextRequest) {
  const nextUrl = request.nextUrl ?? new URL(request.url);
  const { searchParams } = nextUrl;
  const connectionId = (searchParams.get('connection_id') || '').trim();
  const filePath = (searchParams.get('path') || '').trim();
  const maxLines = Math.min(
    Math.max(Number.parseInt(searchParams.get('maxLines') || '200', 10) || 200, 1),
    1000,
  );

  if (!connectionId) {
    return NextResponse.json<ErrorResponse>({ error: 'Missing connection_id parameter' }, { status: 400 });
  }
  if (!filePath) {
    return NextResponse.json<ErrorResponse>({ error: 'Missing path parameter' }, { status: 400 });
  }

  const connection = getRemoteConnection(connectionId);
  if (!connection) {
    return NextResponse.json<ErrorResponse>({ error: 'Remote connection not found' }, { status: 404 });
  }

  try {
    const resolvedPath = assertRemotePathWithinRoot(connection, filePath);
    const metadataResult = await runRemoteCommand(
      connection,
      buildRemotePreviewMetadataScript(resolvedPath),
      { timeoutMs: 30000 },
    );
    const metadata = parseRemotePreviewMetadata(metadataResult.stdout, resolvedPath);

    if (isProbablyBinary(metadata.sample)) {
      return NextResponse.json<FilePreviewResponse>({
        preview: {
          path: resolvedPath,
          content: '',
          language: 'plaintext',
          line_count: 0,
          truncated: false,
          binary: true,
          total_bytes: metadata.totalBytes,
        },
      });
    }

    const contentResult = await runRemoteCommand(
      connection,
      buildRemotePreviewContentScript(resolvedPath, maxLines),
      { timeoutMs: 30000 },
    );
    parseRemotePreviewError(contentResult.stdout, resolvedPath);
    const preview = buildTextPreview(contentResult.stdout, resolvedPath, maxLines, metadata.totalBytes);
    return NextResponse.json<FilePreviewResponse>({ preview });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read remote file';
    const status = message === 'Remote path is outside the configured remote root' ? 400 : 500;
    return NextResponse.json<ErrorResponse>({ error: message }, { status });
  }
}
