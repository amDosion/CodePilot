import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { getExpandedPath } from '@/lib/platform';

const moduleRequire = createRequire(import.meta.url);

let cachedCodexCliPath: string | null | undefined;

type SpawnCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

function findCodexFromPath(): string | undefined {
  const locator = process.platform === 'win32' ? 'where' : '/usr/bin/which';
  const result = spawnSync(locator, ['codex'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: getExpandedPath() },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) return undefined;
  const output = `${result.stdout || ''}`.trim();
  if (!output) return undefined;
  return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function findCodexFromNodeModules(): string | undefined {
  try {
    return moduleRequire.resolve('@openai/codex/bin/codex.js');
  } catch {
    // fall through
  }

  const localCandidate = path.join(process.cwd(), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (fs.existsSync(localCandidate)) {
    return localCandidate;
  }

  return undefined;
}

export function resolveCodexCliPath(): string | undefined {
  if (cachedCodexCliPath !== undefined) {
    return cachedCodexCliPath || undefined;
  }

  const fromEnv = process.env.CODEX_CLI_PATH?.trim();
  if (fromEnv) {
    cachedCodexCliPath = fromEnv;
    return fromEnv;
  }

  const fromPath = findCodexFromPath();
  if (fromPath) {
    cachedCodexCliPath = fromPath;
    return fromPath;
  }

  const fromNodeModules = findCodexFromNodeModules();
  if (fromNodeModules) {
    cachedCodexCliPath = fromNodeModules;
    return fromNodeModules;
  }

  cachedCodexCliPath = null;
  return undefined;
}

export function buildCodexSpawnCommand(args: string[], options: { executablePathOverride?: string } = {}): SpawnCommand {
  const resolved = options.executablePathOverride || resolveCodexCliPath();
  const env = {
    ...process.env,
    PATH: getExpandedPath(),
  };

  if (!resolved) {
    return {
      command: 'codex',
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
