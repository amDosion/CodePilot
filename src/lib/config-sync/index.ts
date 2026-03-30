import { normalizeEngineType } from '@/lib/engine-defaults';
import { syncClaudeConfig } from './claude-sync';
import { syncCodexConfig } from './codex-sync';
import { syncGeminiConfig } from './gemini-sync';

export interface ConfigSyncChanges {
  model?: string;
  mode?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
}

/**
 * Sync GUI setting changes to the corresponding CLI config file.
 * Each CLI has its own sync module — modify only the relevant file
 * when changing CLI-specific behavior.
 *
 * Config file locations:
 *   Claude  → ~/.claude/settings.json
 *   Codex   → ~/.codex/config.toml
 *   Gemini  → ~/.gemini/settings.json
 */
export function syncConfigToFile(engine: string | null | undefined, changes: ConfigSyncChanges): void {
  const engineType = normalizeEngineType(engine);

  try {
    switch (engineType) {
      case 'claude':
        syncClaudeConfig(changes);
        break;
      case 'codex':
        syncCodexConfig(changes);
        break;
      case 'gemini':
        syncGeminiConfig(changes);
        break;
    }
  } catch (e) {
    console.warn(`[config-sync] Failed to sync ${engineType} config:`, e);
  }
}
