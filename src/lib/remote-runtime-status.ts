import type { RemoteConnection } from '@/types';
import type { EngineType } from '@/lib/engine-defaults';
import { quoteShellArg, runRemoteCommand } from '@/lib/remote-ssh';

export interface RemoteRuntimeStatus {
  engine: EngineType;
  available: boolean;
  version: string | null;
  detail: string;
}

export type RemoteRuntimeStatusMap = Record<EngineType, RemoteRuntimeStatus>;

const RUNTIME_SPECS: Record<EngineType, { binary: string; label: string }> = {
  claude: { binary: 'claude', label: 'Claude CLI' },
  codex: { binary: 'codex', label: 'Codex CLI' },
  gemini: { binary: 'gemini', label: 'Gemini CLI' },
};

const BLOCK_START = '__CODEPILOT_RUNTIME_BLOCK__';
const BLOCK_END = '__CODEPILOT_RUNTIME_END__';
const CACHE_KEY = '__codepilot_remote_runtime_status_cache__' as const;
const CACHE_TTL_MS = 20_000;

function getRuntimeCache(): Map<string, { at: number; result: RemoteRuntimeStatusMap }> {
  if (!(globalThis as Record<string, unknown>)[CACHE_KEY]) {
    (globalThis as Record<string, unknown>)[CACHE_KEY] = new Map<string, { at: number; result: RemoteRuntimeStatusMap }>();
  }
  return (globalThis as Record<string, unknown>)[CACHE_KEY] as Map<string, { at: number; result: RemoteRuntimeStatusMap }>;
}

function normalizeVersion(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line || null;
}

function buildCombinedProbeCommand(): string {
  const blocks = (Object.entries(RUNTIME_SPECS) as Array<[EngineType, { binary: string; label: string }]>).map(
    ([engine, spec]) => [
      `if ! command -v ${spec.binary} >/dev/null 2>&1; then`,
      `  printf '%s\\t%s\\tmissing\\n' '${BLOCK_START}' '${engine}'`,
      `  printf '%s\\t%s\\n' '${BLOCK_END}' '${engine}'`,
      'else',
      `  runtime_output="$(${spec.binary} --version 2>&1)"`,
      '  runtime_status=$?',
      '  if [ "$runtime_status" -eq 0 ]; then',
      `    printf '%s\\t%s\\tok\\n' '${BLOCK_START}' '${engine}'`,
      '  else',
      `    printf '%s\\t%s\\terror\\n' '${BLOCK_START}' '${engine}'`,
      '  fi',
      '  printf "%s\\n" "$runtime_output"',
      `  printf '%s\\t%s\\n' '${BLOCK_END}' '${engine}'`,
      'fi',
    ].join('\n'),
  );

  return `\${SHELL:-/bin/bash} -lc ${quoteShellArg(blocks.join('\n'))}`;
}

function createUnavailableStatus(engine: EngineType, detail: string): RemoteRuntimeStatus {
  return {
    engine,
    available: false,
    version: null,
    detail,
  };
}

function createInitialResult(): RemoteRuntimeStatusMap {
  return {
    claude: createUnavailableStatus('claude', 'Claude CLI has not been inspected yet.'),
    codex: createUnavailableStatus('codex', 'Codex CLI has not been inspected yet.'),
    gemini: createUnavailableStatus('gemini', 'Gemini CLI has not been inspected yet.'),
  };
}

function parseCombinedProbeOutput(output: string): RemoteRuntimeStatusMap {
  const result = createInitialResult();
  const lines = output.split(/\r?\n/);
  let activeEngine: EngineType | null = null;
  let activeStatus: 'ok' | 'missing' | 'error' | null = null;
  let detailLines: string[] = [];

  const flushBlock = () => {
    if (!activeEngine || !activeStatus) {
      activeEngine = null;
      activeStatus = null;
      detailLines = [];
      return;
    }

    const spec = RUNTIME_SPECS[activeEngine];
    const detail = detailLines.join('\n').trim();

    if (activeStatus === 'ok') {
      const version = normalizeVersion(detail);
      result[activeEngine] = {
        engine: activeEngine,
        available: true,
        version,
        detail: `${spec.label} detected on the target host.${version ? ` (${version})` : ''}`,
      };
    } else if (activeStatus === 'missing') {
      result[activeEngine] = {
        engine: activeEngine,
        available: false,
        version: null,
        detail: `${spec.label} is not available in the remote login shell environment.`,
      };
    } else {
      result[activeEngine] = {
        engine: activeEngine,
        available: false,
        version: null,
        detail: detail
          ? `${spec.label} exists but failed to report its version in the remote login shell: ${detail}`
          : `${spec.label} exists but failed to report its version in the remote login shell.`,
      };
    }

    activeEngine = null;
    activeStatus = null;
    detailLines = [];
  };

  for (const line of lines) {
    if (line.startsWith(`${BLOCK_START}\t`)) {
      flushBlock();
      const [, engineToken, statusToken] = line.split('\t');
      if (
        (engineToken === 'claude' || engineToken === 'codex' || engineToken === 'gemini')
        && (statusToken === 'ok' || statusToken === 'missing' || statusToken === 'error')
      ) {
        activeEngine = engineToken;
        activeStatus = statusToken;
      }
      continue;
    }

    if (line.startsWith(`${BLOCK_END}\t`)) {
      flushBlock();
      continue;
    }

    if (activeEngine) {
      detailLines.push(line);
    }
  }

  flushBlock();
  return result;
}

export async function inspectRemoteRuntimes(connection: RemoteConnection): Promise<RemoteRuntimeStatusMap> {
  const cache = getRuntimeCache();
  const cached = cache.get(connection.id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const result = await runRemoteCommand(
      connection,
      buildCombinedProbeCommand(),
      { timeoutMs: 12000 },
    );
    const parsed = parseCombinedProbeOutput(result.stdout);
    cache.set(connection.id, { at: Date.now(), result: parsed });
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : String(error).trim();
    const detail = message || 'Failed to inspect remote runtimes on the target host.';
    return {
      claude: createUnavailableStatus('claude', `Failed to inspect Claude CLI on the target host: ${detail}`),
      codex: createUnavailableStatus('codex', `Failed to inspect Codex CLI on the target host: ${detail}`),
      gemini: createUnavailableStatus('gemini', `Failed to inspect Gemini CLI on the target host: ${detail}`),
    };
  }
}

export async function inspectRemoteRuntime(
  connection: RemoteConnection,
  engine: EngineType,
): Promise<RemoteRuntimeStatus> {
  const statuses = await inspectRemoteRuntimes(connection);
  return statuses[engine];
}

export async function assertRemoteRuntimeAvailable(
  connection: RemoteConnection,
  engine: EngineType,
): Promise<RemoteRuntimeStatus> {
  const status = await inspectRemoteRuntime(connection, engine);
  if (!status.available) {
    throw new Error(status.detail);
  }
  return status;
}
