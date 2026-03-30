import 'server-only';

import { getAllProviders } from '@/lib/db';
import {
  DEFAULT_CLAUDE_MODELS,
  PROVIDER_MODEL_LABELS,
  deduplicateClaudeModels,
  type ClaudeModelOption,
} from '@/lib/claude-model-catalog';

export {
  DEFAULT_CLAUDE_MODELS,
  PROVIDER_MODEL_LABELS,
  deduplicateClaudeModels,
  type ClaudeModelOption,
} from '@/lib/claude-model-catalog';

/**
 * Return the Claude model options for a given provider.
 *
 * - Looks up the provider by ID in the database.
 * - Returns provider-specific labels when the base_url is recognized.
 * - Falls back to ANTHROPIC_MODEL from extra_env when available.
 * - Otherwise returns DEFAULT_CLAUDE_MODELS.
 */
export function getClaudeModelsForProvider(providerId?: string | null): ClaudeModelOption[] {
  if (!providerId || providerId === 'env') return DEFAULT_CLAUDE_MODELS;

  try {
    const providers = getAllProviders();
    const provider = providers.find(p => p.id === providerId);
    if (!provider) return DEFAULT_CLAUDE_MODELS;

    const matched = PROVIDER_MODEL_LABELS[provider.base_url];
    if (matched) return deduplicateClaudeModels(matched);

    // Check for ANTHROPIC_MODEL in extra_env (e.g. Volcengine Ark)
    try {
      const envObj = JSON.parse(provider.extra_env || '{}');
      if (envObj.ANTHROPIC_MODEL) {
        return [{ value: envObj.ANTHROPIC_MODEL, label: envObj.ANTHROPIC_MODEL }];
      }
    } catch { /* use default */ }

    return DEFAULT_CLAUDE_MODELS;
  } catch {
    return DEFAULT_CLAUDE_MODELS;
  }
}
