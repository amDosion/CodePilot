/**
 * Dynamic command registry coordinator.
 *
 * For each engine:
 *   1. Tries the dynamic API first (SDK / app-server / CLI introspection)
 *   2. Enriches dynamic entries with metadata from fallback definitions
 *   3. Falls back to hardcoded lists only when dynamic loading fails
 *   4. Appends CodePilot-specific commands
 *   5. Caches results with a TTL
 *
 * This module replaces `src/lib/runtime-command-registry.ts`.
 */

import { normalizeEngineType, type EngineType } from '@/lib/engine-defaults';
import { loadClaudeCommands } from './claude-commands';
import { loadCodexCommands } from './codex-commands';
import { loadGeminiCommands } from './gemini-commands';
import {
  CODEPILOT_COMMANDS,
  getFallbackCommands,
} from './fallbacks';
import type { RuntimeCommandMetadata, DynamicCommandResult, DynamicCommandEntry } from './types';

// Re-export types for convenience
export type { RuntimeCommandMetadata, DynamicCommandResult, DynamicCommandEntry };

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000; // 1 minute

interface CacheEntry {
  commands: RuntimeCommandMetadata[];
  dynamic: boolean;
  timestamp: number;
}

const cache = new Map<EngineType, CacheEntry>();

// ---------------------------------------------------------------------------
// Loader dispatch
// ---------------------------------------------------------------------------

async function loadDynamic(engine: EngineType): Promise<DynamicCommandResult> {
  switch (engine) {
    case 'claude':
      return loadClaudeCommands();
    case 'codex':
      return loadCodexCommands();
    case 'gemini':
      return loadGeminiCommands();
  }
}

// ---------------------------------------------------------------------------
// Enrichment: merge dynamic entries with fallback metadata
// ---------------------------------------------------------------------------

/**
 * When dynamic commands are returned from the SDK, they may lack metadata
 * like `commandMode`, `availability`, `execution`, `argsHint`, etc.
 * We enrich them with matching fallback definitions so the UI has
 * full information.
 */
function enrichDynamicEntry(
  entry: DynamicCommandEntry,
  fallbackLookup: Map<string, RuntimeCommandMetadata>,
): RuntimeCommandMetadata {
  const fallback = fallbackLookup.get(entry.name);

  return {
    name: entry.name,
    description: entry.description || fallback?.description || '',
    aliases: entry.aliases ?? fallback?.aliases ?? [],
    subCommands: entry.subCommands ?? fallback?.subCommands ?? [],
    availability: fallback?.availability ?? 'supported',
    execution: fallback?.execution ?? 'immediate',
    source: fallback?.source ?? 'official',
    commandMode: fallback?.commandMode ?? 'session',
    argsHint: fallback?.argsHint,
    argsOptions: fallback?.argsOptions,
    cliCommand: fallback?.cliCommand,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the full list of runtime commands for an engine.
 *
 * This is the main entry point used by the API route and any
 * server-side consumers.
 */
export async function getCommandsForEngine(engineType: string): Promise<RuntimeCommandMetadata[]> {
  const engine = normalizeEngineType(engineType);

  // Check cache
  const cached = cache.get(engine);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.commands;
  }

  const seen = new Set<string>();
  const result: RuntimeCommandMetadata[] = [];

  // 1. Load dynamic commands
  const dynamicResult = await loadDynamic(engine);
  const fallbackList = getFallbackCommands(engine);
  const fallbackLookup = new Map(fallbackList.map((cmd) => [cmd.name, cmd]));

  // 2. Add dynamic commands (enriched with fallback metadata)
  for (const entry of dynamicResult.commands) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name);
      result.push(enrichDynamicEntry(entry, fallbackLookup));
    }
  }

  // 3. If dynamic loaded, still add any fallback commands not covered by
  //    the dynamic set (e.g. cli-only commands the SDK doesn't report)
  if (dynamicResult.dynamic) {
    for (const cmd of fallbackList) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        result.push(cmd);
      }
    }
  }

  // 4. Append CodePilot-specific commands
  for (const cmd of CODEPILOT_COMMANDS) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name);
      result.push(cmd);
    }
  }

  // Cache
  cache.set(engine, {
    commands: result,
    dynamic: dynamicResult.dynamic,
    timestamp: Date.now(),
  });

  return result;
}

/**
 * Get the list of native command names for an engine.
 *
 * This returns only the command names (strings) that are handled by the
 * backend native command controllers. Used by the frontend hook to
 * determine which commands to intercept locally vs send to the backend.
 */
export async function getNativeCommandNames(engineType: string): Promise<string[]> {
  const commands = await getCommandsForEngine(engineType);
  return commands
    .filter((cmd) => cmd.source === 'official')
    .map((cmd) => cmd.name);
}

/**
 * Invalidate cached commands for an engine (or all engines).
 */
export function invalidateCommandCache(engineType?: string): void {
  if (engineType) {
    cache.delete(normalizeEngineType(engineType));
  } else {
    cache.clear();
  }
}
