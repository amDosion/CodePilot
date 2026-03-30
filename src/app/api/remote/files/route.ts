import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import { runRemoteCommand, quoteShellArg } from '@/lib/remote-ssh';
import type { FileTreeNode } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FILE_TREE_CACHE_KEY = '__codepilot_remote_file_tree_cache__' as const;
const FILE_TREE_CACHE_TTL_MS = 10_000;

/**
 * POST /api/remote/files
 * List files and directories on a remote host, returning a tree structure
 * compatible with the FileTree component.
 *
 * Body: { connection_id, path, depth? }
 * Returns: { tree: FileTreeNode[] }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      connection_id?: string;
      path?: string;
      depth?: number;
    };

    const connectionId = (body.connection_id || '').trim();
    if (!connectionId) {
      return NextResponse.json({ error: 'connection_id is required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    const targetPath = (body.path || '~').trim();
    const depth = Math.min(body.depth || 3, 5);
    const cacheKey = `${connection.id}:${targetPath}:${depth}`;
    const cache = getFileTreeCache();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < FILE_TREE_CACHE_TTL_MS) {
      return NextResponse.json(cached.payload);
    }

    const result = await runRemoteCommand(connection, buildRemoteFileTreeCommand(targetPath, depth), { timeoutMs: 15000 });
    const lines = result.stdout.split('\n').filter(Boolean);

    if (lines.length === 0) {
      const payload = { tree: [] };
      cache.set(cacheKey, { at: Date.now(), payload });
      return NextResponse.json(payload);
    }

    const resolvedPath = lines[0];
    const classifiedLines = lines.slice(1);

    // Parse into a flat list of entries
    interface FlatEntry {
      relativePath: string;
      type: 'file' | 'directory';
      name: string;
      extension?: string;
    }

    const entries: FlatEntry[] = [];
    for (const line of classifiedLines) {
      const tabIdx = line.indexOf('\t');
      if (tabIdx < 0) continue;
      const typeChar = line.slice(0, tabIdx);
      let relPath = line.slice(tabIdx + 1);
      // Strip leading ./
      if (relPath.startsWith('./')) relPath = relPath.slice(2);
      if (!relPath) continue;

      const name = relPath.split('/').pop() || relPath;
      // Skip hidden files/dirs at root
      if (name.startsWith('.') && !name.startsWith('.env')) continue;

      const ext = typeChar === 'f' ? (name.includes('.') ? name.split('.').pop() : undefined) : undefined;
      entries.push({
        relativePath: relPath,
        type: typeChar === 'd' ? 'directory' : 'file',
        name,
        extension: ext,
      });
    }

    // Build tree from flat paths
    const payload = { tree: buildTree(entries, resolvedPath) };
    cache.set(cacheKey, { at: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list remote files';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function getFileTreeCache(): Map<string, { at: number; payload: { tree: FileTreeNode[] } }> {
  if (!(globalThis as Record<string, unknown>)[FILE_TREE_CACHE_KEY]) {
    (globalThis as Record<string, unknown>)[FILE_TREE_CACHE_KEY] = new Map<string, { at: number; payload: { tree: FileTreeNode[] } }>();
  }
  return (globalThis as Record<string, unknown>)[FILE_TREE_CACHE_KEY] as Map<string, { at: number; payload: { tree: FileTreeNode[] } }>;
}

function buildRemoteFileTreeCommand(targetPath: string, depth: number): string {
  const excludes = [
    'node_modules', '.git', '.next', 'dist', 'build', '__pycache__',
    '.cache', '.vscode', '.idea', 'vendor', 'target', '.tox',
  ].map((dir) => `-name ${quoteShellArg(dir)} -prune`).join(' -o ');

  return [
    `cd ${quoteShellArg(targetPath)} 2>/dev/null || exit 0`,
    'pwd',
    `find . -maxdepth ${depth} \\( ${excludes} \\) -o \\( -type d -print -o -type f -print \\) 2>/dev/null | sort | while IFS= read -r p; do`,
    '  [ "$p" = "." ] && continue',
    '  rel="$p"',
    '  case "$rel" in ./*) rel="${rel#./}" ;; esac',
    '  [ -z "$rel" ] && continue',
    '  name="${rel##*/}"',
    '  case "$name" in .env*) ;; .*) continue ;; esac',
    '  if [ -d "$p" ]; then',
    '    printf "d\\t%s\\n" "$rel"',
    '  elif [ -f "$p" ]; then',
    '    printf "f\\t%s\\n" "$rel"',
    '  fi',
    'done',
  ].join('\n');
}

function buildTree(entries: Array<{ relativePath: string; type: 'file' | 'directory'; name: string; extension?: string }>, basePath: string): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const dirMap = new Map<string, FileTreeNode>();

  // Sort entries so directories come before their children
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  for (const entry of entries) {
    const fullPath = basePath === '/' ? `/${entry.relativePath}` : `${basePath}/${entry.relativePath}`;
    const node: FileTreeNode = {
      name: entry.name,
      path: fullPath,
      type: entry.type,
      extension: entry.extension,
      children: entry.type === 'directory' ? [] : undefined,
    };

    if (entry.type === 'directory') {
      dirMap.set(entry.relativePath, node);
    }

    // Find parent directory
    const lastSlash = entry.relativePath.lastIndexOf('/');
    if (lastSlash < 0) {
      // Top-level entry
      root.push(node);
    } else {
      const parentRelPath = entry.relativePath.slice(0, lastSlash);
      const parent = dirMap.get(parentRelPath);
      if (parent?.children) {
        parent.children.push(node);
      } else {
        // Orphan (parent was filtered out) — add to root
        root.push(node);
      }
    }
  }

  return root;
}
