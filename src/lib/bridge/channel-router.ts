/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import type { ChannelAddress, ChannelBinding, ChannelType } from './types';
import {
  getChannelBinding,
  upsertChannelBinding,
  updateChannelBinding,
  listChannelBindings,
  getSession,
  createSession,
  getSetting,
  updateSessionProviderId,
} from '../db';
import {
  normalizeEngineType,
  normalizeReasoningEffort,
} from '../engine-defaults';
import { getCliDefaultsForEngine } from '@/lib/runtime-config';

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const existing = getChannelBinding(address.channelType, address.chatId);
  if (existing) {
    // Verify the linked session still exists; if not, create a new one
    const session = getSession(existing.codepilotSessionId);
    if (session) return existing;
    // Session was deleted — recreate
    return createBinding(address);
  }
  return createBinding(address);
}

/**
 * Create a new binding with a fresh CodePilot session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const defaultCwd = workingDirectory
    || getSetting('bridge_default_work_dir')
    || process.env.HOME
    || '';
  const defaultEngineType = normalizeEngineType(getSetting('bridge_default_engine_type') || 'claude');
  const defaultModel = getSetting('bridge_default_model')
    || getCliDefaultsForEngine(defaultEngineType).model;
  const defaultProviderId = getSetting('bridge_default_provider_id')
    || getCliDefaultsForEngine(defaultEngineType).providerId;
  const defaultReasoningEffort = defaultEngineType === 'codex'
    ? (
        normalizeReasoningEffort(getSetting('bridge_default_reasoning_effort'))
        || getCliDefaultsForEngine('codex').reasoningEffort
      )
    : '';

  const displayName = address.displayName || address.chatId;
  const session = createSession(
    `Bridge: ${displayName}`,
    defaultModel,
    defaultReasoningEffort,
    undefined,
    defaultCwd,
    'code',
    defaultProviderId,
    defaultEngineType,
  );

  if (defaultProviderId) {
    updateSessionProviderId(session.id, defaultProviderId);
  }

  return upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId: session.id,
    engineType: session.engine_type,
    engineSessionId: session.engine_session_id || session.sdk_session_id || '',
    workingDirectory: defaultCwd,
    model: session.model,
  });
}

/**
 * Bind an IM chat to an existing CodePilot session.
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
): ChannelBinding | null {
  const session = getSession(codepilotSessionId);
  if (!session) return null;

  return upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId,
    engineType: session.engine_type,
    engineSessionId: session.engine_session_id || session.sdk_session_id || '',
    workingDirectory: session.working_directory,
    model: session.model,
  });
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'engineType' | 'engineSessionId' | 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  updateChannelBinding(id, updates);
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return listChannelBindings(channelType);
}
