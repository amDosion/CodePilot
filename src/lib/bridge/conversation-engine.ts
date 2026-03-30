/**
 * Conversation Engine — processes inbound IM messages through selected engine.
 *
 * Takes a ChannelBinding + inbound message, calls engine.stream(),
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import type { ChannelBinding } from './types';
import type { SSEEvent, TokenUsage, MessageContentBlock, FileAttachment } from '@/types';
import { createAgentEngine } from '@/lib/agent/engine-factory';
import {
  addMessage,
  getMessages,
  acquireSessionLock,
  renewSessionLock,
  releaseSessionLock,
  setSessionRuntimeStatus,
  updateSdkSessionId,
  updateSessionModel,
  updateSessionMode,
  syncSdkTasks,
  getSession,
  getProvider,
  getDefaultProviderId,
  getSetting,
} from '../db';
import {
  normalizeEngineType,
  normalizeReasoningEffort,
} from '@/lib/engine-defaults';
import { getCliDefaultsForEngine } from '@/lib/runtime-config';
import crypto from 'crypto';

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

export interface ConversationResult {
  responseText: string;
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** Engine-native session/thread id captured from status/result events, for session resume */
  engineSessionId: string | null;
  /** Compatibility alias for older call sites. */
  sdkSessionId: string | null;
}

function shouldResetCodexResumeOnError(message: string | undefined): boolean {
  const text = (message || '').toLowerCase();
  return text.includes('recorded with model') && text.includes('resuming with');
}

function mapPermissionModeToSessionMode(permissionMode: string | undefined): 'code' | 'plan' | 'ask' | null {
  const normalized = (permissionMode || '').trim().toLowerCase();
  if (normalized === 'plan') return 'plan';
  if (normalized === 'default') return 'ask';
  if (normalized === 'acceptedits' || normalized === 'bypasspermissions') return 'code';
  return null;
}

/**
 * Process an inbound message: send to selected engine, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
): Promise<ConversationResult> {
  const sessionId = binding.codepilotSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      engineSessionId: null,
      sdkSessionId: null,
    };
  }

  setSessionRuntimeStatus(sessionId, 'running');

  // Lock renewal interval
  const renewalInterval = setInterval(() => {
    try { renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    // Resolve session early — needed for workingDirectory and provider resolution
    const session = getSession(sessionId);

    // Save user message — persist file attachments to disk using the same
    // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
    let savedContent = text;
    if (files && files.length > 0) {
      const workDir = binding.workingDirectory || session?.working_directory || '';
      if (workDir) {
        try {
          const uploadDir = path.join(workDir, '.codepilot-uploads');
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          const fileMeta = files.map((f) => {
            const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
            const buffer = Buffer.from(f.data, 'base64');
            fs.writeFileSync(filePath, buffer);
            return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
          });
          savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${text}`;
        } catch (err) {
          console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} image(s) attached] ${text}`;
        }
      } else {
        savedContent = `[${files.length} image(s) attached] ${text}`;
      }
    }
    addMessage(sessionId, 'user', savedContent);

    const resolvedEngineType = normalizeEngineType(binding.engineType || session?.engine_type || 'claude');

    // Resolve provider
    let resolvedProvider: import('@/types').ApiProvider | undefined;
    const providerId = session?.provider_id || getCliDefaultsForEngine(resolvedEngineType).providerId;
    if (resolvedEngineType === 'codex' || resolvedEngineType === 'gemini') {
      if (providerId && providerId !== 'env') {
        resolvedProvider = getProvider(providerId);
      }
    } else {
      if (providerId && providerId !== 'env') {
        resolvedProvider = getProvider(providerId);
      }
      if (!resolvedProvider) {
        const defaultId = getDefaultProviderId();
        if (defaultId) resolvedProvider = getProvider(defaultId);
      }
    }

    // Effective model
    const effectiveModel = binding.model
      || session?.model
      || (resolvedEngineType === 'claude'
        ? (getSetting('default_model') || getCliDefaultsForEngine('claude').model)
        : getCliDefaultsForEngine(resolvedEngineType).model);
    const effectiveReasoningEffort = resolvedEngineType === 'codex'
      ? (
          normalizeReasoningEffort(session?.reasoning_effort)
          || getCliDefaultsForEngine('codex').reasoningEffort
        )
      : undefined;

    // Resolve engine type: binding.engine_type first, then session.engine_type.
    const bindingEngineType = (binding.engineType || '').trim() || undefined;
    const agentEngine = createAgentEngine({
      engine: bindingEngineType,
      session: session ?? null,
    });

    // Permission mode from binding mode
    let requestedPermissionMode: string;
    switch (binding.mode) {
      case 'plan': requestedPermissionMode = 'plan'; break;
      case 'ask': requestedPermissionMode = 'default'; break;
      default: requestedPermissionMode = 'acceptEdits'; break;
    }
    // Codex currently has no runtime permission-mode switching; degrade safely.
    const permissionMode = agentEngine.capabilities.includes('permission_mode')
      ? requestedPermissionMode
      : undefined;

    // Load conversation history for context
    const { messages: recentMsgs } = getMessages(sessionId, { limit: 50 });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const engineSessionId =
      binding.engineSessionId
      || binding.sdkSessionId
      || session?.engine_session_id
      || session?.sdk_session_id
      || undefined;

    const stream = agentEngine.stream({
      prompt: text,
      sessionId,
      engineSessionId,
      model: effectiveModel,
      modelReasoningEffort: effectiveReasoningEffort || undefined,
      systemPrompt: session?.system_prompt || undefined,
      workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
      workspaceTransport: session?.workspace_transport,
      remoteConnectionId: session?.remote_connection_id || undefined,
      remotePath: session?.remote_path || undefined,
      abortController,
      permissionMode,
      provider: resolvedProvider,
      conversationHistory: historyMsgs,
      files,
      onRuntimeStatusChange: (status: string) => {
        try { setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
      },
    });

    // Consume the stream server-side (replicate collectStreamResponse pattern).
    // Permission requests are forwarded immediately via the callback during streaming
    // because the stream blocks until permission is resolved — we can't wait until after.
    return await consumeStream(stream, sessionId, onPermissionRequest, onPartialText);
  } finally {
    clearInterval(renewalInterval);
    releaseSessionLock(sessionId, lockId);
    setSessionRuntimeStatus(sessionId, 'idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
): Promise<ConversationResult> {
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  let clearedInvalidResumeId = false;
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedEngineSessionId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (event.type) {
          case 'text':
            currentText += event.data;
            if (onPartialText) {
              previewText += event.data;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            break;

          case 'tool_use': {
            if (currentText.trim()) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            try {
              const toolData = JSON.parse(event.data);
              contentBlocks.push({
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: toolData.input,
              });
            } catch { /* skip */ }
            break;
          }

          case 'tool_result': {
            try {
              const resultData = JSON.parse(event.data);
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: resultData.tool_use_id,
                content: resultData.content,
                is_error: resultData.is_error || false,
              };
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                contentBlocks.push(newBlock);
              }
            } catch { /* skip */ }
            break;
          }

          case 'permission_request': {
            try {
              const permData = JSON.parse(event.data);
              const perm: PermissionRequestInfo = {
                permissionRequestId: permData.permissionRequestId,
                toolName: permData.toolName,
                toolInput: permData.toolInput,
                suggestions: permData.suggestions,
              };
              permissionRequests.push(perm);
              // Forward immediately — the stream blocks until the permission is
              // resolved, so we must send the IM prompt *now*, not after the stream ends.
              if (onPermissionRequest) {
                onPermissionRequest(perm).catch((err) => {
                  console.error('[conversation-engine] Failed to forward permission request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'status': {
            try {
              const statusData = JSON.parse(event.data);
              if (statusData.session_id) {
                capturedEngineSessionId = statusData.session_id;
                updateSdkSessionId(sessionId, statusData.session_id);
              }
              if (statusData.model) {
                updateSessionModel(sessionId, statusData.model);
              }
            } catch { /* skip */ }
            break;
          }

          case 'task_update': {
            try {
              const taskData = JSON.parse(event.data);
              if (taskData.session_id && taskData.todos) {
                syncSdkTasks(taskData.session_id, taskData.todos);
              }
            } catch { /* skip */ }
            break;
          }

          case 'mode_changed': {
            const nextMode = mapPermissionModeToSessionMode(event.data);
            if (nextMode) {
              updateSessionMode(sessionId, nextMode);
            }
            break;
          }

          case 'error':
            hasError = true;
            errorMessage = event.data || 'Unknown error';
            if (!clearedInvalidResumeId && shouldResetCodexResumeOnError(errorMessage)) {
              capturedEngineSessionId = null;
              try {
                updateSdkSessionId(sessionId, '');
                clearedInvalidResumeId = true;
              } catch {
                // best effort
              }
            }
            break;

          case 'result': {
            try {
              const resultData = JSON.parse(event.data);
              if (resultData.usage) tokenUsage = resultData.usage;
              if (resultData.is_error) hasError = true;
              if (resultData.session_id) {
                capturedEngineSessionId = resultData.session_id;
                updateSdkSessionId(sessionId, resultData.session_id);
              }
            } catch { /* skip */ }
            break;
          }

          // tool_output, tool_timeout, done — ignored for bridge
        }
      }
    }

    // Flush remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    // Save assistant message
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content) {
        addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    // Extract text-only response for IM delivery
    const responseText = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return {
      responseText,
      tokenUsage,
      hasError,
      errorMessage,
      permissionRequests,
      engineSessionId: capturedEngineSessionId,
      sdkSessionId: capturedEngineSessionId,
    };
  } catch (e) {
    // Best-effort save on stream error
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content) {
        addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';
    const streamErrorMessage = isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error');
    if (!clearedInvalidResumeId && shouldResetCodexResumeOnError(streamErrorMessage)) {
      capturedEngineSessionId = null;
      try {
        updateSdkSessionId(sessionId, '');
        clearedInvalidResumeId = true;
      } catch {
        // best effort
      }
    }

    return {
      responseText: '',
      tokenUsage,
      hasError: true,
      errorMessage: streamErrorMessage,
      permissionRequests,
      engineSessionId: capturedEngineSessionId,
      sdkSessionId: capturedEngineSessionId,
    };
  }
}
