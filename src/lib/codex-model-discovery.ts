import type { ProviderModelGroup } from '@/types';
import { DEFAULT_CODEX_MODEL_OPTIONS, normalizeCodexModelListPayload } from '@/lib/codex-model-options';
import { withCodexAppServer } from '@/lib/codex-app-server-client';

type CodexModels = ProviderModelGroup['models'];

export async function discoverCodexModelsViaCli(timeoutMs = 4000): Promise<CodexModels | null> {
  try {
    const models = await withCodexAppServer(
      async (client) => client.listModels({ includeHidden: false, limit: 128 }),
      { requestTimeoutMs: timeoutMs },
    );
    const discovered = normalizeCodexModelListPayload(models);
    return discovered.length > 0 ? discovered : null;
  } catch {
    return null;
  }
}

let cache: { expiresAt: number; models: CodexModels } | null = null;
let inflight: Promise<CodexModels> | null = null;

export async function getCodexModelsCached(): Promise<CodexModels> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.models;
  }

  if (!inflight) {
    inflight = (async () => {
      const discovered = await discoverCodexModelsViaCli();
      const models = discovered && discovered.length > 0
        ? discovered
        : DEFAULT_CODEX_MODEL_OPTIONS;
      cache = {
        models,
        expiresAt: Date.now() + 30_000,
      };
      return models;
    })().finally(() => {
      inflight = null;
    });
  }

  return inflight;
}
