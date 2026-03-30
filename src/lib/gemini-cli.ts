import fs from 'fs';
import path from 'path';
import { spawnSync, execFile } from 'child_process';
import { promisify } from 'util';
import { getExpandedPath } from '@/lib/platform';

const execFileAsync = promisify(execFile);

let cachedGeminiCliPath: string | null | undefined;

type SpawnCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

function findGeminiFromPath(): string | undefined {
  const locator = process.platform === 'win32' ? 'where' : '/usr/bin/which';
  const result = spawnSync(locator, ['gemini'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: getExpandedPath() },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) return undefined;
  const output = `${result.stdout || ''}`.trim();
  if (!output) return undefined;
  return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function findGeminiFromNodeModules(): string | undefined {
  try {
    const packageJsonPath = path.join(process.cwd(), 'node_modules', '@google', 'gemini-cli', 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return undefined;
    }
    const packageDir = path.dirname(packageJsonPath);
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as { bin?: string | Record<string, string> };
    const binEntry = typeof pkg.bin === 'string'
      ? pkg.bin
      : (pkg.bin && typeof pkg.bin === 'object' ? pkg.bin.gemini : undefined);
    if (typeof binEntry === 'string' && binEntry.trim()) {
      const resolved = path.join(packageDir, binEntry);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
  } catch {
    // fall through
  }

  const localCandidate = path.join(process.cwd(), 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js');
  if (fs.existsSync(localCandidate)) {
    return localCandidate;
  }

  return undefined;
}

export function resolveGeminiCliPath(): string | undefined {
  if (cachedGeminiCliPath !== undefined) {
    return cachedGeminiCliPath || undefined;
  }

  const fromEnv = process.env.GEMINI_CLI_PATH?.trim();
  if (fromEnv) {
    cachedGeminiCliPath = fromEnv;
    return fromEnv;
  }

  const fromPath = findGeminiFromPath();
  if (fromPath) {
    cachedGeminiCliPath = fromPath;
    return fromPath;
  }

  const fromNodeModules = findGeminiFromNodeModules();
  if (fromNodeModules) {
    cachedGeminiCliPath = fromNodeModules;
    return fromNodeModules;
  }

  cachedGeminiCliPath = null;
  return undefined;
}

export function buildGeminiSpawnCommand(args: string[]): SpawnCommand {
  const resolved = resolveGeminiCliPath();
  const env = {
    ...process.env,
    PATH: getExpandedPath(),
  };

  if (!resolved) {
    return {
      command: 'gemini',
      args,
      env,
    };
  }

  if (resolved.toLowerCase().endsWith('.js')) {
    return {
      command: process.execPath,
      args: [resolved, ...args],
      env,
    };
  }

  return {
    command: resolved,
    args,
    env,
  };
}

export async function getGeminiCliVersion(): Promise<string | null> {
  const command = buildGeminiSpawnCommand(['--version']);
  try {
    const { stdout } = await execFileAsync(command.command, command.args, {
      timeout: 5000,
      env: command.env,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
