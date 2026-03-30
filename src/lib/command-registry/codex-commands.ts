/**
 * Codex dynamic command loader.
 *
 * Priority:
 *   1. Built-in commands from the fallback list (no runtime API for these)
 *   2. User-defined skills from the Codex app-server `listSkills()` API (dynamic)
 *
 * When user skills are successfully loaded, they are merged with the
 * built-in fallback commands and `dynamic` is set to `true`.
 */

import { getCodexSkillsCached } from "@/lib/codex-skill-discovery";
import { CODEX_FALLBACK_COMMANDS } from "./fallbacks";
import type { DynamicCommandResult, DynamicCommandEntry } from "./types";

/**
 * Load Codex commands.
 *
 * Built-in commands always come from the fallback list (Codex has no API to
 * enumerate them). User-defined skills are loaded dynamically from the
 * app-server when available and merged in.
 */
export async function loadCodexCommands(): Promise<DynamicCommandResult> {
  // Start with built-in commands from fallback (always present)
  const builtinEntries: DynamicCommandEntry[] = CODEX_FALLBACK_COMMANDS.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    aliases: [...cmd.aliases],
    subCommands: [...cmd.subCommands],
  }));

  // Try to load user-defined skills dynamically
  try {
    const userSkills = await getCodexSkillsCached();

    if (userSkills.length > 0) {
      const builtinNames = new Set(builtinEntries.map((e) => e.name));

      const skillEntries: DynamicCommandEntry[] = userSkills
        .filter((skill) => !builtinNames.has(skill.name))
        .map((skill) => ({
          name: skill.name,
          description: skill.description || "",
          aliases: skill.aliases || [],
          subCommands: skill.subCommands || [],
        }));

      return {
        dynamic: true,
        commands: [...builtinEntries, ...skillEntries],
      };
    }
  } catch {
    // App-server unavailable — fall through to fallback-only
  }

  return {
    dynamic: false,
    commands: builtinEntries,
  };
}
