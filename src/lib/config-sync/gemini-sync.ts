import { readRuntimeSettings, writeRuntimeSettings } from '@/lib/runtime-config';
import type { ConfigSyncChanges } from './index';

export function syncGeminiConfig(changes: ConfigSyncChanges): void {
  const settings = readRuntimeSettings('gemini');
  let changed = false;

  if (changes.model) {
    settings.model = changes.model;
    changed = true;
  }

  if (changes.mode) {
    if (!settings.permissions || typeof settings.permissions !== 'object') {
      settings.permissions = {};
    }
    (settings.permissions as Record<string, unknown>).defaultMode = changes.mode;
    changed = true;
  }

  if (changed) {
    writeRuntimeSettings('gemini', settings);
  }
}
