/**
 * Unified Command Dispatcher — the single routing entry point for all
 * slash commands.  It does NOT execute commands; it returns a routing
 * decision that the caller (ChatView / page.tsx) acts on.
 */

import type { RuntimeCommandMetadata } from '@/lib/runtime-command-catalog';
import { findRuntimeCommand } from '@/lib/runtime-command-catalog';
import { parseSlashCommand } from '@/hooks/useNativeCommandController';

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

export type CommandRoute =
  | { layer: 'stream'; commandName: string; args: string }
  | { layer: 'native'; commandName: string; args: string }
  | { layer: 'local'; commandName: string; args: string }
  | { layer: 'cli-passthrough'; commandName: string; args: string; cliCommand: string }
  | { layer: 'prompt'; commandName: string; args: string }
  | { layer: 'cli-only'; commandName: string; args: string }
  | { layer: 'unknown'; command: string };

// ---------------------------------------------------------------------------
// Core routing function
// ---------------------------------------------------------------------------

/**
 * Determine the execution route for a slash command.
 *
 * Routing priority (from architecture doc):
 *   1. execution === 'stream'       -> stream layer
 *   2. execution === 'cli-only'     -> cli-only hint
 *   3. execution === 'terminal'     -> cli passthrough
 *   4. execution === 'prompt'       -> send as user prompt
 *   5. commandMode === 'local'      -> local UI handler
 *   6. execution === 'native'       -> native controller (POST /api/chat/native-command)
 *   7. execution === 'immediate' && commandMode !== 'local' -> native controller
 *   8. execution === 'immediate' && commandMode === 'local' -> local UI handler
 *   9. fallback                     -> native (for any remaining 'immediate' commands)
 */
export function routeCommand(
  rawCommand: string,
  engineType: string,
  runtimeCommands: RuntimeCommandMetadata[],
): CommandRoute {
  const { commandName, args } = parseSlashCommand(rawCommand);
  if (!commandName) {
    return { layer: 'unknown', command: rawCommand };
  }

  const meta = findRuntimeCommand(runtimeCommands, rawCommand);
  if (!meta) {
    return { layer: 'unknown', command: rawCommand };
  }

  // Use the canonical name from metadata (handles aliases)
  const canonicalName = meta.name;

  // 1. Stream commands
  if (meta.execution === 'stream') {
    return { layer: 'stream', commandName: canonicalName, args };
  }

  // 2. CLI-only commands
  if (meta.execution === 'cli-only' || meta.availability === 'cli-only') {
    return { layer: 'cli-only', commandName: canonicalName, args };
  }

  // 3. Terminal passthrough
  if (meta.execution === 'terminal' && meta.cliCommand) {
    return { layer: 'cli-passthrough', commandName: canonicalName, args, cliCommand: meta.cliCommand };
  }

  // 4. Prompt commands (sent as user message to LLM)
  if (meta.execution === 'prompt') {
    return { layer: 'prompt', commandName: canonicalName, args };
  }

  // 5. Native execution type
  if (meta.execution === 'native') {
    return { layer: 'native', commandName: canonicalName, args };
  }

  // 6. Immediate commands — split by commandMode
  if (meta.execution === 'immediate' || meta.execution === 'local') {
    if (meta.commandMode === 'local') {
      return { layer: 'local', commandName: canonicalName, args };
    }
    // Non-local immediate commands go to native controller
    return { layer: 'native', commandName: canonicalName, args };
  }

  // 7. Unsupported / unrecognized execution type — treat as unknown
  if (meta.execution === 'unsupported') {
    return { layer: 'unknown', command: rawCommand };
  }

  // Fallback: if we have metadata but can't determine the route, try native
  return { layer: 'native', commandName: canonicalName, args };
}
