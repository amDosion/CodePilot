/**
 * Gemini dynamic command loader.
 *
 * Priority:
 *   1. Dynamic loading via BuiltinCommandLoader from the installed Gemini CLI
 *   2. Fallback list from fallbacks.ts
 */

import { getGeminiBuiltinCommandMetadata } from "@/lib/gemini-command-metadata";
import { GEMINI_FALLBACK_COMMANDS } from "./fallbacks";
import type { DynamicCommandResult } from "./types";

/**
 * Load Gemini commands dynamically from the installed Gemini CLI package.
 *
 * Attempts to introspect the Gemini CLI BuiltinCommandLoader first.
 * Falls back to the hardcoded list only when dynamic loading fails or
 * returns no commands. The `dynamic` flag indicates the source.
 */
export async function loadGeminiCommands(): Promise<DynamicCommandResult> {
  try {
    const dynamicCommands = await getGeminiBuiltinCommandMetadata();

    if (dynamicCommands.length > 0) {
      return {
        dynamic: true,
        commands: dynamicCommands.map((cmd) => ({
          name: cmd.name,
          description: cmd.description || "",
          aliases: cmd.altNames || [],
          subCommands: cmd.subCommands || [],
        })),
      };
    }
  } catch (error) {
    console.warn('[gemini-commands] Dynamic loading failed:', error instanceof Error ? error.message : String(error));
  }

  return {
    dynamic: false,
    commands: GEMINI_FALLBACK_COMMANDS.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      aliases: [...cmd.aliases],
      subCommands: [...cmd.subCommands],
    })),
  };
}
