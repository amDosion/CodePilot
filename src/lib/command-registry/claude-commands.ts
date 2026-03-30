/**
 * Claude dynamic command loader.
 *
 * Priority:
 *   1. SDK `supportedCommands()` via cached metadata (populated on session start)
 *   2. Fallback list from fallbacks.ts
 */

import { getCachedClaudeCommandMetadata } from '@/lib/claude-command-metadata';
import { CLAUDE_FALLBACK_COMMANDS } from './fallbacks';
import type { DynamicCommandResult } from './types';

/**
 * Load Claude commands dynamically from the SDK cache.
 *
 * Returns `{ dynamic: true }` when the SDK cache has fresh data,
 * or `{ dynamic: false }` with the hardcoded fallback list.
 */
export function loadClaudeCommands(): DynamicCommandResult {
  const cached = getCachedClaudeCommandMetadata();

  if (cached.length > 0) {
    return {
      dynamic: true,
      commands: cached.map((cmd) => ({
        name: cmd.name,
        description: cmd.description || '',
        aliases: cmd.aliases,
        subCommands: cmd.subCommands,
      })),
    };
  }

  return {
    dynamic: false,
    commands: CLAUDE_FALLBACK_COMMANDS.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      aliases: [...cmd.aliases],
      subCommands: [...cmd.subCommands],
    })),
  };
}
