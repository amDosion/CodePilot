import {
  normalizeEngineType,
  normalizeReasoningEffort,
  type EngineType,
} from '@/lib/engine-defaults';

export interface EnginePreferences {
  model: string;
  providerId: string;
  reasoningEffort: string;
}

export type EnginePreferenceScope = 'local' | 'remote';
export interface EnginePreferenceTarget {
  scope?: EnginePreferenceScope;
  remoteConnectionId?: string | null;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function normalizeTarget(
  target: EnginePreferenceTarget | EnginePreferenceScope = 'local',
): { scope: EnginePreferenceScope; remoteConnectionId: string } {
  if (typeof target === 'string') {
    return { scope: target, remoteConnectionId: '' };
  }

  return {
    scope: target.scope === 'remote' ? 'remote' : 'local',
    remoteConnectionId: (target.remoteConnectionId || '').trim(),
  };
}

export function buildEnginePreferenceTarget(
  workspaceMode: EnginePreferenceScope,
  remoteConnectionId?: string | null,
): EnginePreferenceTarget {
  if (workspaceMode === 'remote') {
    return { scope: 'remote', remoteConnectionId };
  }

  return { scope: 'local' };
}

function activeEngineKeyCandidates(target: EnginePreferenceTarget | EnginePreferenceScope): string[] {
  const resolved = normalizeTarget(target);
  const keys: string[] = [];

  if (resolved.scope === 'remote' && resolved.remoteConnectionId) {
    keys.push(`codepilot:remote-connection:${resolved.remoteConnectionId}:last-engine-type`);
  }

  keys.push(
    resolved.scope === 'remote'
      ? 'codepilot:last-remote-engine-type'
      : 'codepilot:last-engine-type',
  );

  return keys;
}

function fallbackKeyCandidates(
  target: EnginePreferenceTarget | EnginePreferenceScope,
  field: 'model' | 'provider_id' | 'reasoning_effort',
): string[] {
  const resolved = normalizeTarget(target);
  const keys: string[] = [];

  if (resolved.scope === 'remote' && resolved.remoteConnectionId) {
    switch (field) {
      case 'model':
        keys.push(`codepilot:remote-connection:${resolved.remoteConnectionId}:last-model`);
        break;
      case 'provider_id':
        keys.push(`codepilot:remote-connection:${resolved.remoteConnectionId}:last-provider-id`);
        break;
      case 'reasoning_effort':
        keys.push(`codepilot:remote-connection:${resolved.remoteConnectionId}:last-reasoning-effort`);
        break;
    }
  }

  if (resolved.scope === 'remote') {
    switch (field) {
      case 'model':
        keys.push('codepilot:last-remote-model');
        break;
      case 'provider_id':
        keys.push('codepilot:last-remote-provider-id');
        break;
      case 'reasoning_effort':
        keys.push('codepilot:last-remote-reasoning-effort');
        break;
    }
    return keys;
  }

  switch (field) {
    case 'model':
      keys.push('codepilot:last-model');
      break;
    case 'provider_id':
      keys.push('codepilot:last-provider-id');
      break;
    case 'reasoning_effort':
      keys.push('codepilot:last-reasoning-effort');
      break;
  }

  return keys;
}

function preferenceKeyCandidates(
  engine: EngineType,
  field: 'model' | 'provider_id' | 'reasoning_effort',
  target: EnginePreferenceTarget | EnginePreferenceScope = 'local',
): string[] {
  const resolved = normalizeTarget(target);
  const keys: string[] = [];

  if (resolved.scope === 'remote' && resolved.remoteConnectionId) {
    switch (field) {
      case 'model':
        keys.push(`codepilot:remote-connection:${resolved.remoteConnectionId}:${engine}:last-model`);
        break;
      case 'provider_id':
        keys.push(`codepilot:remote-connection:${resolved.remoteConnectionId}:${engine}:last-provider-id`);
        break;
      case 'reasoning_effort':
        keys.push(`codepilot:remote-connection:${resolved.remoteConnectionId}:${engine}:last-reasoning-effort`);
        break;
    }
  }

  const legacyPrefix = resolved.scope === 'remote' ? `codepilot:remote:${engine}` : `codepilot:${engine}`;
  switch (field) {
    case 'model':
      keys.push(`${legacyPrefix}:last-model`);
      break;
    case 'provider_id':
      keys.push(`${legacyPrefix}:last-provider-id`);
      break;
    case 'reasoning_effort':
      keys.push(`${legacyPrefix}:last-reasoning-effort`);
      break;
  }

  return keys;
}

function readFirstKey(keys: string[]): string | null {
  if (!isBrowser()) return null;

  for (const key of keys) {
    const value = window.localStorage.getItem(key);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function getStoredValue(
  engine: EngineType,
  field: 'model' | 'provider_id' | 'reasoning_effort',
  target: EnginePreferenceTarget | EnginePreferenceScope = 'local',
): string | null {
  if (!isBrowser()) return null;

  const specific = readFirstKey(preferenceKeyCandidates(engine, field, target));
  if (specific !== null) {
    return specific;
  }

  const activeEngine = readActiveEngine(target);
  if (activeEngine !== engine) {
    return null;
  }

  return readFirstKey(fallbackKeyCandidates(target, field));
}

export function readActiveEngine(
  target: EnginePreferenceTarget | EnginePreferenceScope = 'local',
): EngineType {
  if (!isBrowser()) return 'claude';
  return normalizeEngineType(readFirstKey(activeEngineKeyCandidates(target)));
}

export function readEnginePreferences(
  engine?: string | null,
  target: EnginePreferenceTarget | EnginePreferenceScope = 'local',
  fallbacks?: { model?: string; providerId?: string; reasoningEffort?: string },
): EnginePreferences {
  const normalizedEngine = normalizeEngineType(engine);
  const storedModel = getStoredValue(normalizedEngine, 'model', target);
  const storedProviderId = getStoredValue(normalizedEngine, 'provider_id', target);
  const storedReasoningEffort = getStoredValue(normalizedEngine, 'reasoning_effort', target);

  return {
    model: storedModel && storedModel.trim()
      ? storedModel
      : (fallbacks?.model || ''),
    providerId: storedProviderId ?? (fallbacks?.providerId ?? ((normalizedEngine === 'codex' || normalizedEngine === 'gemini') ? 'env' : '')),
    reasoningEffort:
      normalizedEngine === 'codex'
        ? (
            normalizeReasoningEffort(storedReasoningEffort)
            || (fallbacks?.reasoningEffort || '')
          )
        : '',
  };
}

export function persistEnginePreferences(
  engine: string | null | undefined,
  updates: Partial<EnginePreferences>,
  target: EnginePreferenceTarget | EnginePreferenceScope = 'local',
): void {
  if (!isBrowser()) return;

  const normalizedEngine = normalizeEngineType(engine);
  const activeKey = activeEngineKeyCandidates(target)[0];
  window.localStorage.setItem(activeKey, normalizedEngine);
  const resolved = normalizeTarget(target);
  const modelKey = preferenceKeyCandidates(normalizedEngine, 'model', resolved)[0];
  const providerKey = preferenceKeyCandidates(normalizedEngine, 'provider_id', resolved)[0];
  const reasoningKey = preferenceKeyCandidates(normalizedEngine, 'reasoning_effort', resolved)[0];
  const fallbackModelKey = fallbackKeyCandidates(resolved, 'model')[0];
  const fallbackProviderKey = fallbackKeyCandidates(resolved, 'provider_id')[0];
  const fallbackReasoningKey = fallbackKeyCandidates(resolved, 'reasoning_effort')[0];

  if (updates.model !== undefined) {
    window.localStorage.setItem(modelKey, updates.model);
    window.localStorage.setItem(fallbackModelKey, updates.model);
  }

  if (updates.providerId !== undefined) {
    window.localStorage.setItem(providerKey, updates.providerId);
    window.localStorage.setItem(fallbackProviderKey, updates.providerId);
  }

  if (normalizedEngine === 'codex' && updates.reasoningEffort !== undefined) {
    const normalizedReasoning =
      normalizeReasoningEffort(updates.reasoningEffort)
      || 'medium';
    if (normalizedReasoning) {
      window.localStorage.setItem(reasoningKey, normalizedReasoning);
      window.localStorage.setItem(fallbackReasoningKey, normalizedReasoning);
    }
  }
}
