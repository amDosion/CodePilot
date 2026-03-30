/**
 * Claude model discovery via SDK runtime.
 *
 * Mirrors the Codex pattern (`codex-model-discovery.ts`): after the first
 * successful Claude session, `supportedModels()` populates the cache and
 * subsequent calls to `getClaudeModelsCached()` return real CLI data instead
 * of the hardcoded fallback.
 */

import type { ProviderModelGroup } from '@/types';
import { DEFAULT_CLAUDE_MODELS, type ClaudeModelOption } from '@/lib/claude-model-catalog';

type ClaudeModels = ProviderModelGroup['models'];

/**
 * Shape returned by the Claude SDK `supportedModels()` / `initializationResult().models`.
 */
export interface ClaudeSDKModelInfo {
  value: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cache: { expiresAt: number; models: ClaudeModels } | null = null;

/**
 * Convert SDK ModelInfo[] to ProviderModelGroup models format.
 */
export function normalizeClaudeSDKModels(sdkModels: ClaudeSDKModelInfo[]): ClaudeModels {
  if (!Array.isArray(sdkModels) || sdkModels.length === 0) return [];
  return sdkModels
    .filter((m) => m.value)
    .map((m) => ({
      value: m.value,
      label: m.displayName || m.value,
      reasoning_efforts: m.supportsEffort && m.supportedEffortLevels?.length
        ? m.supportedEffortLevels
        : undefined,
    }));
}

/**
 * Called by `claude-persistent-client.ts` after the first successful turn
 * to populate the model cache from the SDK's `supportedModels()` result.
 */
export function updateClaudeModelCache(sdkModels: ClaudeSDKModelInfo[]): void {
  const normalized = normalizeClaudeSDKModels(sdkModels);
  if (normalized.length > 0) {
    cache = {
      models: normalized,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
  }
}

/**
 * Returns cached Claude models from the SDK, falling back to hardcoded defaults.
 *
 * Unlike Codex (which spawns a CLI to discover models), Claude models
 * are populated opportunistically after the first session initializes.
 */
export function getClaudeModelsCached(): ClaudeModels {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.models;
  }
  return DEFAULT_CLAUDE_MODELS;
}

/**
 * Merge SDK-discovered models with provider-specific labels.
 * SDK data takes priority; unrecognized provider models are appended.
 */
export function mergeWithProviderLabels(
  sdkModels: ClaudeModels,
  providerModels: ClaudeModelOption[],
): ClaudeModels {
  if (sdkModels.length === 0) return providerModels;
  // SDK models are authoritative — use them as base,
  // override labels from provider config when available
  const providerMap = new Map(providerModels.map((m) => [m.value, m.label]));
  return sdkModels.map((m) => ({
    ...m,
    label: providerMap.get(m.value) || m.label,
  }));
}
