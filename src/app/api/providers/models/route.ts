import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { getAllProviders, getDefaultProviderId } from '@/lib/db';
import {
  PROVIDER_MODEL_LABELS,
  deduplicateClaudeModels,
} from '@/lib/claude-model-catalog';
import { getClaudeModelsCached, mergeWithProviderLabels } from '@/lib/claude-model-discovery';
import { getCodexModelsCached } from '@/lib/codex-model-discovery';
import { DEFAULT_GEMINI_MODEL_OPTIONS } from '@/lib/gemini-model-options';
import { readRuntimeSettings } from '@/lib/runtime-config';
import type { ErrorResponse, ProviderModelGroup } from '@/types';

export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readProjectGeminiSettings(cwd?: string | null): Record<string, unknown> {
  if (!cwd) return {};
  try {
    const filePath = path.join(cwd, '.gemini', 'settings.json');
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) {
      return {};
    }
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractGeminiModelNames(settings: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const model = settings.model;
  if (typeof model === 'string' && model.trim()) {
    candidates.push(model.trim());
  } else if (isRecord(model) && typeof model.name === 'string' && model.name.trim()) {
    candidates.push(model.name.trim());
  }
  return candidates;
}

function buildGeminiModelOptions(cwd?: string | null): ProviderModelGroup['models'] {
  const configuredNames = [
    process.env.GEMINI_MODEL,
    ...extractGeminiModelNames(readProjectGeminiSettings(cwd)),
    ...extractGeminiModelNames(readRuntimeSettings('gemini')),
  ]
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim());

  const byValue = new Set<string>();
  const configuredOptions: ProviderModelGroup['models'] = [];

  for (const name of configuredNames) {
    if (byValue.has(name)) continue;
    byValue.add(name);
    const existing = DEFAULT_GEMINI_MODEL_OPTIONS.find((option) => option.value === name);
    configuredOptions.push(existing || { value: name, label: name });
  }

  const merged = [...configuredOptions];
  for (const option of DEFAULT_GEMINI_MODEL_OPTIONS) {
    if (byValue.has(option.value)) continue;
    byValue.add(option.value);
    merged.push(option);
  }

  return merged;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const engineType = (searchParams.get('engine_type') || 'claude').trim().toLowerCase();
    const cwd = searchParams.get('cwd');
    const providers = getAllProviders();
    const groups: ProviderModelGroup[] = [];

    if (engineType === 'codex') {
      const codexModels = await getCodexModelsCached();
      groups.push({
        provider_id: 'env',
        provider_name: 'Codex CLI',
        provider_type: 'codex',
        models: codexModels,
      });

      return NextResponse.json({
        groups,
        default_provider_id: 'env',
      });
    }

    if (engineType === 'gemini') {
      groups.push({
        provider_id: 'env',
        provider_name: 'Gemini CLI',
        provider_type: 'gemini',
        models: buildGeminiModelOptions(cwd),
      });

      return NextResponse.json({
        groups,
        default_provider_id: 'env',
      });
    }

    // Always show the built-in Claude Code provider group.
    // Claude Code CLI stores credentials in ~/.claude/ (via `claude login`),
    // which the SDK subprocess can read — even without ANTHROPIC_API_KEY in env.
    // Prefer SDK-discovered models (cached after first session); fall back to hardcoded.
    groups.push({
      provider_id: 'env',
      provider_name: 'Claude Code',
      provider_type: 'anthropic',
      models: getClaudeModelsCached(),
    });

    // Provider types that are not LLMs (e.g. image generation) — skip in chat model selector
    const MEDIA_PROVIDER_TYPES = new Set(['gemini-image']);

    // Build a group for each configured provider
    const sdkModels = getClaudeModelsCached();
    for (const provider of providers) {
      if (MEDIA_PROVIDER_TYPES.has(provider.provider_type)) continue;
      const matched = PROVIDER_MODEL_LABELS[provider.base_url];

      let rawModels: typeof sdkModels;
      if (matched) {
        // Known provider — merge SDK effort data with provider-specific labels
        rawModels = mergeWithProviderLabels(sdkModels, matched);
      } else {
        // Unknown provider — check for ANTHROPIC_MODEL in extra_env
        try {
          const envObj = JSON.parse(provider.extra_env || '{}');
          if (envObj.ANTHROPIC_MODEL) {
            rawModels = [{ value: envObj.ANTHROPIC_MODEL, label: envObj.ANTHROPIC_MODEL }];
          } else {
            rawModels = sdkModels;
          }
        } catch {
          rawModels = sdkModels;
        }
      }

      const models = deduplicateClaudeModels(rawModels);

      groups.push({
        provider_id: provider.id,
        provider_name: provider.name,
        provider_type: provider.provider_type,
        models,
      });
    }

    // Determine default provider
    const defaultProviderId = getDefaultProviderId() || groups[0].provider_id;

    return NextResponse.json({
      groups,
      default_provider_id: defaultProviderId,
    });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to get models' },
      { status: 500 }
    );
  }
}
