import { readRuntimeSettings, writeRuntimeSettings } from '@/lib/runtime-config';
import type { ConfigSyncChanges } from './index';

const POLICY_TO_API: Record<string, string> = {
  'suggest': 'on-request',
  'auto-edit': 'on-failure',
  'full-auto': 'never',
  'on-request': 'on-request',
  'on-failure': 'on-failure',
  'never': 'never',
};

const POLICY_TO_SANDBOX: Record<string, string> = {
  'on-request': 'read-only',
  'on-failure': 'workspace-write',
  'never': 'danger-full-access',
};

export function syncCodexConfig(changes: ConfigSyncChanges): void {
  const settings = readRuntimeSettings('codex');
  let changed = false;

  if (changes.model) {
    settings.model = changes.model;
    changed = true;
  }

  if (changes.reasoningEffort) {
    settings.model_reasoning_effort = changes.reasoningEffort;
    changed = true;
  }

  if (changes.approvalPolicy) {
    const apiValue = POLICY_TO_API[changes.approvalPolicy] || changes.approvalPolicy;
    settings.approval_policy = apiValue;
    settings.sandbox_mode = POLICY_TO_SANDBOX[apiValue] || 'read-only';
    changed = true;
  }

  if (changed) {
    writeRuntimeSettings('codex', settings);
  }
}
