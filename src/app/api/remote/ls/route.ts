import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import { runRemoteCommand, quoteShellArg } from '@/lib/remote-ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RemoteDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

const ROOT_PREFIX = '__CODEPILOT_ROOT__:';
const CWD_PREFIX = '__CODEPILOT_CWD__:';
const CLAMPED_PREFIX = '__CODEPILOT_CLAMPED__:';
const ERROR_PREFIX = '__CODEPILOT_ERROR__:';

export function buildRemoteDirectoryProbeScript(targetPath: string, remoteRoot: string): string {
  const normalizedTarget = targetPath.trim();
  const normalizedRoot = remoteRoot.trim();

  return [
    `TARGET_PATH=${quoteShellArg(normalizedTarget)}`,
    `REMOTE_ROOT=${quoteShellArg(normalizedRoot)}`,
    'target="$TARGET_PATH"',
    'resolved_root=""',
    'resolved_current=""',
    'clamped="0"',
    'if [ -n "$REMOTE_ROOT" ]; then',
    '  resolved_root="$(cd "$REMOTE_ROOT" 2>/dev/null && pwd -P)" || {',
    `    printf '%s%s\\n' '${ERROR_PREFIX}' 'invalid-root'`,
    '    exit 0',
    '  }',
    'fi',
    'if [ -z "$target" ]; then',
    '  if [ -n "$resolved_root" ]; then',
    '    target="$resolved_root"',
    '  else',
    '    target="$HOME"',
    '  fi',
    'fi',
    'case "$target" in',
    '  "~") target="$HOME" ;;',
    '  "~/"*) target="$HOME/${target#~/}" ;;',
    'esac',
    'if [ "${target#/}" = "$target" ]; then',
    '  if [ -n "$resolved_root" ]; then',
    '    target="$resolved_root/$target"',
    '  else',
    '    target="$HOME/$target"',
    '  fi',
    'fi',
    'if ! cd "$target" 2>/dev/null; then',
    '  if [ -n "$resolved_root" ]; then',
    '    clamped="1"',
    '    cd "$resolved_root" 2>/dev/null || {',
    `      printf '%s%s\\n' '${ERROR_PREFIX}' 'invalid-root'`,
    '      exit 0',
    '    }',
    '  else',
    `    printf '%s%s\\n' '${ERROR_PREFIX}' 'missing-target'`,
    '    exit 0',
    '  fi',
    'fi',
    'resolved_current="$(pwd -P)"',
    'if [ -n "$resolved_root" ]; then',
    '  case "$resolved_current" in',
    '    "$resolved_root"|"$resolved_root"/*) ;;',
    '    *)',
    '      clamped="1"',
    '      cd "$resolved_root" 2>/dev/null || {',
    `        printf '%s%s\\n' '${ERROR_PREFIX}' 'invalid-root'`,
    '        exit 0',
    '      }',
    '      resolved_current="$(pwd -P)"',
    '      ;;',
    '  esac',
    'fi',
    `printf '%s%s\\n' '${ROOT_PREFIX}' "$resolved_root"`,
    `printf '%s%s\\n' '${CWD_PREFIX}' "$resolved_current"`,
    `printf '%s%s\\n' '${CLAMPED_PREFIX}' "$clamped"`,
    'ls -1apd -- */ 2>/dev/null || true',
  ].join('\n');
}

/** POST: List directories on remote host for path selector */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      connection_id?: string;
      path?: string;
    };

    const connectionId = (body.connection_id || '').trim();
    if (!connectionId) {
      return NextResponse.json({ error: 'connection_id is required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    const targetPath = (body.path || connection.remote_root || '~').trim();
    const cmd = buildRemoteDirectoryProbeScript(targetPath, connection.remote_root || '');

    const result = await runRemoteCommand(connection, cmd, { timeoutMs: 10000 });
    const lines = result.stdout.split('\n').filter(Boolean);
    const errorLine = lines.find((line) => line.startsWith(ERROR_PREFIX));
    if (errorLine) {
      const code = errorLine.slice(ERROR_PREFIX.length).trim();
      const message = code === 'invalid-root'
        ? 'Configured remote root is invalid or inaccessible'
        : `Failed to access remote directory: ${targetPath}`;
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const rootLine = lines.find((line) => line.startsWith(ROOT_PREFIX));
    const cwdLine = lines.find((line) => line.startsWith(CWD_PREFIX));
    const clampedLine = lines.find((line) => line.startsWith(CLAMPED_PREFIX));
    const resolvedPath = cwdLine?.slice(CWD_PREFIX.length).trim() || targetPath;
    const rootPath = rootLine?.slice(ROOT_PREFIX.length).trim() || '';
    const clampedToRoot = clampedLine?.slice(CLAMPED_PREFIX.length).trim() === '1';

    if (!cwdLine) {
      return NextResponse.json(
        { error: `Failed to access remote directory: ${targetPath}` },
        { status: 400 },
      );
    }
    const entries: RemoteDirEntry[] = [];

    for (const line of lines) {
      if (
        line.startsWith(ROOT_PREFIX)
        || line.startsWith(CWD_PREFIX)
        || line.startsWith(CLAMPED_PREFIX)
        || line.startsWith(ERROR_PREFIX)
      ) {
        continue;
      }
      const name = line.replace(/\/$/, '');
      if (name === '.' || name === '..') continue;
      entries.push({
        name,
        path: resolvedPath === '/' ? `/${name}` : `${resolvedPath}/${name}`,
        is_dir: true,
      });
    }

    return NextResponse.json({
      current_path: resolvedPath,
      root_path: rootPath || null,
      clamped_to_root: clampedToRoot,
      entries,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list remote directory';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
