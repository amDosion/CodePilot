/**
 * Types for the dynamic command registry.
 *
 * Re-exports RuntimeCommandMetadata from the catalog (single source of truth)
 * and adds registry-internal types.
 */

export type { RuntimeCommandMetadata } from '@/lib/runtime-command-catalog';
export type { EngineType } from '@/lib/engine-defaults';

/** Result from a dynamic command source (SDK, app-server, CLI). */
export interface DynamicCommandResult {
  /** Whether the commands were loaded dynamically (true) or from fallback (false). */
  dynamic: boolean;
  /** The loaded commands. */
  commands: DynamicCommandEntry[];
}

/** A single dynamic command entry before enrichment into RuntimeCommandMetadata. */
export interface DynamicCommandEntry {
  name: string;
  description?: string;
  aliases?: string[];
  subCommands?: string[];
}
