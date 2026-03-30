import { spawnSync } from 'child_process';
import { getExpandedPath } from '@/lib/platform';

let cachedClaudeCliPath: string | null | undefined;

type SpawnCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

function findClaudeFromPath(): string | undefined {
  const locator = process.platform === 'win32' ? 'where' : '/usr/bin/which';
  const result = spawnSync(locator, ['claude'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: getExpandedPath() },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) return undefined;
  const output = `${result.stdout || ''}`.trim();
  if (!output) return undefined;
  return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

export function resolveClaudeCliPath(): string | undefined {
  if (cachedClaudeCliPath !== undefined) {
    return cachedClaudeCliPath || undefined;
  }

  const fromEnv = process.env.CLAUDE_CLI_PATH?.trim();
  if (fromEnv) {
    cachedClaudeCliPath = fromEnv;
    return fromEnv;
  }

  const fromPath = findClaudeFromPath();
  if (fromPath) {
    cachedClaudeCliPath = fromPath;
    return fromPath;
  }

  cachedClaudeCliPath = null;
  return undefined;
}

export function buildClaudeSpawnCommand(args: string[]): SpawnCommand {
  const resolved = resolveClaudeCliPath();
  const env = {
    ...process.env,
    PATH: getExpandedPath(),
  };

  return {
    command: resolved || 'claude',
    args,
    env,
  };
}
