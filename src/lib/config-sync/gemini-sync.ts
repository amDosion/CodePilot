import { readRuntimeSettings, writeRuntimeSettings } from '@/lib/runtime-config';
import type { ConfigSyncChanges } from './index';

export function syncGeminiConfig(changes: ConfigSyncChanges): void {
  const settings = readRuntimeSettings('gemini');
  let changed = false;

  if (changes.model) {
    // Gemini expects model as object: { name: "model-name" }
    if (!settings.model || typeof settings.model !== 'object') {
      settings.model = {};
    }
    (settings.model as Record<string, unknown>).name = changes.model;
    changed = true;
  }

  if (changes.mode) {
    // Gemini uses general.defaultApprovalMode with values: default | auto_edit | plan
    // CodePilot modes: code -> default, plan -> plan
    const geminiMode = changes.mode === 'plan' ? 'plan' : 'default';
    if (!settings.general || typeof settings.general !== 'object') {
      settings.general = {};
    }
    (settings.general as Record<string, unknown>).defaultApprovalMode = geminiMode;
    changed = true;
  }

  if (changed) {
    writeRuntimeSettings('gemini', settings);
  }
}
