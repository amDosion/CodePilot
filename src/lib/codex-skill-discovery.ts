/**
 * Codex dynamic command/skill discovery via the app-server `skills/list` API.
 *
 * Similar to the Claude warm-cache pattern: on first call, connects to the
 * Codex app-server to fetch skills, caches the result with a TTL, and returns
 * them in the OfficialCommandRecord format expected by the runtime command
 * registry. Falls back gracefully when the app-server is unavailable.
 */

import { withCodexAppServer } from '@/lib/codex-app-server-client';

interface CodexSkillRecord {
  name: string;
  description: string;
  aliases?: string[];
  subCommands?: string[];
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 4000;

let cachedAt = 0;
let cachedSkills: CodexSkillRecord[] | null = null;
let fetchInProgress: Promise<CodexSkillRecord[]> | null = null;

/**
 * Returns cached Codex skills if available and fresh, otherwise triggers a
 * background fetch. Returns an empty array when no cache is available yet
 * (the caller should fall back to the hardcoded list).
 */
export async function getCodexSkillsCached(): Promise<CodexSkillRecord[]> {
  if (cachedSkills && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedSkills;
  }

  // If a fetch is already in flight, wait for it (with a short timeout)
  if (fetchInProgress) {
    try {
      return await fetchInProgress;
    } catch {
      return cachedSkills || [];
    }
  }

  // Start a new fetch but don't block indefinitely
  fetchInProgress = fetchCodexSkills();
  try {
    const skills = await fetchInProgress;
    return skills;
  } catch {
    return cachedSkills || [];
  } finally {
    fetchInProgress = null;
  }
}

/**
 * Proactively update the cache (called after a Codex session starts).
 */
export function updateCodexSkillsCache(skills: CodexSkillRecord[]): void {
  cachedSkills = skills;
  cachedAt = Date.now();
}

async function fetchCodexSkills(): Promise<CodexSkillRecord[]> {
  try {
    const skills = await withCodexAppServer(
      async (client) => client.listSkills({ forceReload: false }),
      { requestTimeoutMs: FETCH_TIMEOUT_MS },
    );

    const records: CodexSkillRecord[] = skills
      .filter((s) => s.name)
      .map((s) => ({
        name: s.name!,
        description: s.description || '',
      }));

    if (records.length > 0) {
      cachedSkills = records;
      cachedAt = Date.now();
    }

    return records;
  } catch {
    // App-server unavailable — return whatever we have cached
    return cachedSkills || [];
  }
}
