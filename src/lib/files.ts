import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import type { FileTreeNode, FilePreview } from '@/types';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '__pycache__',
  '.cache',
  '.turbo',
  'coverage',
  '.output',
  'build',
]);

const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'markdown',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  ps1: 'powershell',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'vue',
  svelte: 'svelte',
  prisma: 'prisma',
  env: 'dotenv',
  lua: 'lua',
  r: 'r',
  php: 'php',
  dart: 'dart',
  zig: 'zig',
};

const FILENAME_LANGUAGE_MAP: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  caddyfile: 'caddy',
  jenkinsfile: 'groovy',
  procfile: 'bash',
  gemfile: 'ruby',
  rakefile: 'ruby',
  brewfile: 'ruby',
  readme: 'markdown',
  changelog: 'markdown',
  license: 'text',
};

export function getFileLanguage(ext: string): string {
  const normalized = ext.replace(/^\./, '').toLowerCase();
  return LANGUAGE_MAP[normalized] || 'plaintext';
}

export function getFileLanguageForPath(filePath: string): string {
  const baseName = path.basename(filePath).toLowerCase();
  const exactMatch = FILENAME_LANGUAGE_MAP[baseName];
  if (exactMatch) {
    return exactMatch;
  }

  if (baseName.startsWith('.env')) {
    return 'dotenv';
  }
  if (baseName === '.gitignore' || baseName === '.dockerignore') {
    return 'gitignore';
  }
  if (baseName.endsWith('.conf')) {
    return 'nginx';
  }
  if (baseName.endsWith('.ini')) {
    return 'ini';
  }
  if (baseName.endsWith('.md') || baseName.endsWith('.mdx')) {
    return 'markdown';
  }

  return getFileLanguage(path.extname(baseName));
}

export function isPathSafe(basePath: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

/**
 * Check if a path is a filesystem root (e.g., `/`, `C:\`, `D:\`).
 * Used to prevent using root as a baseDir for file browsing.
 */
export function isRootPath(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved === path.parse(resolved).root;
}

export function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;

  let suspiciousBytes = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    const isWhitespace = byte === 9 || byte === 10 || byte === 13;
    const isAsciiText = byte >= 32 && byte <= 126;
    const isExtendedText = byte >= 128;
    if (!isWhitespace && !isAsciiText && !isExtendedText) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / buffer.length > 0.1;
}

async function detectBinaryFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return isProbablyBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function scanDirectory(dir: string, depth: number = 3): Promise<FileTreeNode[]> {
  const resolvedDir = path.resolve(dir);

  try {
    await fs.access(resolvedDir);
  } catch {
    return [];
  }

  return scanDirectoryRecursive(resolvedDir, depth);
}

async function scanDirectoryRecursive(dir: string, depth: number): Promise<FileTreeNode[]> {
  if (depth <= 0) return [];

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileTreeNode[] = [];

  // Sort: directories first, then files, both alphabetically
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    // Skip hidden files/dirs (except common config files)
    if (entry.name.startsWith('.') && !entry.name.startsWith('.env')) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;

      const children = await scanDirectoryRecursive(fullPath, depth - 1);
      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'directory',
        children,
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).replace(/^\./, '');
      let size: number | undefined;
      try {
        const stat = await fs.stat(fullPath);
        size = stat.size;
      } catch {
        // Skip files we can't stat
      }

      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        size,
        extension: ext || undefined,
      });
    }
  }

  return nodes;
}

export async function readFilePreview(filePath: string, maxLines: number = 200): Promise<FilePreview> {
  const resolvedPath = path.resolve(filePath);

  try {
    await fs.access(resolvedPath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const language = getFileLanguageForPath(resolvedPath);
  const normalizedMaxLines = Math.max(1, maxLines);

  if (await detectBinaryFile(resolvedPath)) {
    return {
      path: resolvedPath,
      content: '',
      language: 'plaintext',
      line_count: 0,
      truncated: false,
      binary: true,
      total_bytes: stat.size,
    };
  }

  const lines: string[] = [];
  let truncated = false;
  const stream = createReadStream(resolvedPath, { encoding: 'utf-8' });
  const lineReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lineReader) {
      if (lines.length >= normalizedMaxLines) {
        truncated = true;
        break;
      }
      lines.push(line);
    }
  } finally {
    lineReader.close();
    stream.destroy();
  }

  return {
    path: resolvedPath,
    content: lines.join('\n'),
    language,
    line_count: truncated ? lines.length + 1 : lines.length,
    truncated,
    binary: false,
    total_bytes: stat.size,
  };
}
