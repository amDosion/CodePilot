/**
 * Warm cache for Claude SDK slash command metadata.
 *
 * On the first successful Claude session, `supportedCommands()` is called
 * proactively and the result cached here. Subsequent calls to
 * `getRuntimeCommandRegistry('claude')` will prefer this dynamic data
 * over the hardcoded fallback list.
 */

export interface ClaudeCommandMetadata {
  name: string;
  description: string;
  aliases?: string[];
  subCommands?: string[];
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedAt = 0;
let cachedCommands: ClaudeCommandMetadata[] | null = null;

export function getCachedClaudeCommandMetadata(): ClaudeCommandMetadata[] {
  if (cachedCommands && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedCommands;
  }
  return [];
}

export function updateClaudeCommandCache(
  commands: Array<{ name: string; description?: string }>,
): void {
  cachedCommands = commands
    .filter((c) => c.name)
    .map((c) => ({
      name: c.name,
      description: c.description || '',
    }));
  cachedAt = Date.now();
}
