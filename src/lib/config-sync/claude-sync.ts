import { readRuntimeSettings, writeRuntimeSettings } from '@/lib/runtime-config';
import type { ConfigSyncChanges } from './index';

const MODE_TO_PERMISSION: Record<string, string> = {
  'ask': 'default',
  'code': 'acceptEdits',
  'plan': 'plan',
  'bypass': 'bypassPermissions',
  'dont-ask': 'dontAsk',
};

export function syncClaudeConfig(changes: ConfigSyncChanges): void {
  const settings = readRuntimeSettings('claude');
  let changed = false;

  if (changes.model) {
    settings.model = changes.model;
    changed = true;
  }

  if (changes.reasoningEffort) {
    settings.reasoningEffort = changes.reasoningEffort;
    changed = true;
  }

  if (changes.mode) {
    settings.permissionMode = MODE_TO_PERMISSION[changes.mode] || changes.mode;
    changed = true;
  }

  if (changed) {
    writeRuntimeSettings('claude', settings);
  }
}
