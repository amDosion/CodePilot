import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { resolveGeminiCliPath } from '@/lib/gemini-cli';

export interface GeminiBuiltinCommandMetadata {
  name: string;
  description: string;
  altNames: string[];
  subCommands: string[];
}

const CACHE_TTL_MS = 60_000;

let cachedAt = 0;
let cachedCommands: GeminiBuiltinCommandMetadata[] | null = null;

function findGeminiPackageRoot(startPath: string): string | null {
  let current: string;
  try {
    current = fs.realpathSync(startPath);
  } catch {
    return null;
  }
  if (fs.existsSync(current) && fs.statSync(current).isFile()) {
    current = path.dirname(current);
  }

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { name?: string };
        if (pkg.name === '@google/gemini-cli') {
          return current;
        }
      } catch {
        // ignore
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveBuiltinLoaderPath(): string | null {
  const cliPath = resolveGeminiCliPath();
  if (!cliPath) return null;

  const packageRoot = findGeminiPackageRoot(cliPath);
  if (!packageRoot) return null;

  const candidates = [
    path.join(packageRoot, 'src', 'services', 'BuiltinCommandLoader.js'),
    path.join(packageRoot, 'dist', 'src', 'services', 'BuiltinCommandLoader.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export async function getGeminiBuiltinCommandMetadata(): Promise<GeminiBuiltinCommandMetadata[]> {
  if (cachedCommands && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedCommands;
  }

  const loaderPath = resolveBuiltinLoaderPath();
  if (!loaderPath) {
    console.warn('[gemini-command-metadata] resolveBuiltinLoaderPath returned null');
    return [];
  }

  try {
    fs.mkdirSync(path.join(os.tmpdir(), 'gemini', 'ide'), { recursive: true });

    // Use a separate .mjs worker to load the ESM Gemini CLI module
    // This avoids Turbopack/CJS vs ESM conflicts in the Next.js server
    const workerPath = path.resolve(path.dirname(loaderPath), '..', '..', '..', '..', '..', '..', 'apps', 'CodePilot', 'src', 'lib', 'gemini-command-loader-worker.mjs');
    
    // Fallback: try relative to project root
    const projectWorker = path.join(process.cwd(), 'src', 'lib', 'gemini-command-loader-worker.mjs');
    const actualWorker = fs.existsSync(workerPath) ? workerPath : projectWorker;

    if (!fs.existsSync(actualWorker)) {
      console.warn('[gemini-command-metadata] Worker not found at', actualWorker);
      return [];
    }

    const output = execFileSync(process.execPath, [actualWorker, loaderPath], {
      timeout: 10000,
      encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });

    const parsed = JSON.parse(output) as Array<{
      name?: string;
      description?: string;
      altNames?: string[];
      subCommands?: string[];
    }>;

    cachedCommands = parsed
      .filter((command): command is NonNullable<typeof command> => Boolean(command?.name))
      .map((command) => ({
        name: command.name || '',
        description: typeof command.description === 'string' ? command.description : '',
        altNames: Array.isArray(command.altNames) ? command.altNames.filter(Boolean) : [],
        subCommands: Array.isArray(command.subCommands) ? command.subCommands.filter(Boolean) : [],
      }));
    cachedAt = Date.now();
    return cachedCommands;
  } catch (error) {
    console.warn('[gemini-command-metadata] Failed to load:', error instanceof Error ? error.message : String(error));
    return [];
  }
}
