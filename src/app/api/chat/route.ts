import { NextRequest } from 'next/server';
import { createAgentEngine } from '@/lib/agent/engine-factory';
import { isCodexStreamNativeCommand, streamCodexNativeCommand } from '@/lib/agent/codex-native-stream';
import { isClaudeStreamNativeCommand, streamClaudeNativeCommand } from '@/lib/agent/claude-native-stream';
import { addMessage, getMessages, getSession, updateSessionTitle, updateSdkSessionId, updateSessionModel, updateSessionReasoningEffort, updateSessionProvider, updateSessionProviderId, updateSessionMode, getSetting, getProvider, getDefaultProviderId, acquireSessionLock, renewSessionLock, releaseSessionLock, setSessionRuntimeStatus, syncSdkTasks } from '@/lib/db';
import { notifySessionStart, notifySessionComplete, notifySessionError } from '@/lib/telegram-bot';
import type { SendMessageRequest, SSEEvent, TokenUsage, MessageContentBlock, FileAttachment, NativeCommandControllerRequest } from '@/types';
import { normalizeEngineType, normalizeReasoningEffort } from '@/lib/engine-defaults';
import { getCliDefaultsForEngine } from '@/lib/runtime-config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export async function POST(request: NextRequest) {
  let activeSessionId: string | undefined;
  let activeLockId: string | undefined;

  try {
    const body: SendMessageRequest & {
      files?: FileAttachment[];
      toolTimeout?: number;
      provider_id?: string;
      systemPromptAppend?: string;
      engine_type?: string;
      reasoning_effort?: string;
      native_command?: { command_name?: string; args?: string };
    } = await request.json();
    const { session_id, content, model, mode, files, toolTimeout, provider_id, systemPromptAppend, engine_type, reasoning_effort, native_command } = body;

    console.log('[chat API] content length:', content.length, 'first 200 chars:', content.slice(0, 200));
    console.log('[chat API] systemPromptAppend:', systemPromptAppend ? `${systemPromptAppend.length} chars` : 'none');

    if (!session_id || !content) {
      return new Response(JSON.stringify({ error: 'session_id and content are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const session = getSession(session_id);
    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Acquire exclusive lock for this session to prevent concurrent requests
    const lockId = crypto.randomBytes(8).toString('hex');
    const lockAcquired = acquireSessionLock(session_id, lockId, `chat-${process.pid}`, 600);
    if (!lockAcquired) {
      return new Response(
        JSON.stringify({ error: 'Session is busy processing another request', code: 'SESSION_BUSY' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    }
    activeSessionId = session_id;
    activeLockId = lockId;
    setSessionRuntimeStatus(session_id, 'running');

    // Telegram notification: session started (fire-and-forget)
    const telegramNotifyOpts = {
      sessionId: session_id,
      sessionTitle: session.title !== 'New Chat' ? session.title : content.slice(0, 50),
      workingDirectory: session.working_directory,
    };
    notifySessionStart(telegramNotifyOpts).catch(() => {});

    const earlyEngineType = normalizeEngineType(engine_type || session.engine_type || 'claude');
    const hasStreamNativeCommand = isRecord(native_command)
      && typeof native_command.command_name === 'string'
      && (
        (earlyEngineType === 'codex' && isCodexStreamNativeCommand(native_command.command_name))
        || (earlyEngineType === 'claude' && isClaudeStreamNativeCommand(native_command.command_name))
      );

    // Save user message — persist file metadata so attachments survive page reload.
    // Native streaming slash commands run as control turns and should not be stored as user chat messages.
    let savedContent = content;
    let fileMeta: Array<{ id: string; name: string; type: string; size: number; filePath: string }> | undefined;
    if (!hasStreamNativeCommand) {
      if (files && files.length > 0) {
        const workDir = session.working_directory;
        const uploadDir = path.join(workDir, '.codepilot-uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        fileMeta = files.map((f) => {
          const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
          const buffer = Buffer.from(f.data, 'base64');
          fs.writeFileSync(filePath, buffer);
          return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
        });
        savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${content}`;
      }
      addMessage(session_id, 'user', savedContent);

      // Auto-generate title from first message if still default
      if (session.title === 'New Chat') {
        const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
        updateSessionTitle(session_id, title);
      }
    }

    const resolvedEngineType = normalizeEngineType(engine_type || session.engine_type || 'claude');
    const nativeCommandRequest: NativeCommandControllerRequest | null = isRecord(native_command)
      && typeof native_command.command_name === 'string'
      && (isCodexStreamNativeCommand(native_command.command_name) || isClaudeStreamNativeCommand(native_command.command_name))
      ? {
          session_id,
          engine_type: resolvedEngineType,
          command: content,
          command_name: native_command.command_name.trim().toLowerCase(),
          args: typeof native_command.args === 'string' ? native_command.args.trim() : undefined,
          context: {
            mode: mode || session.mode || 'code',
            model: model || session.model || undefined,
            provider_id: provider_id || session.provider_id || 'env',
            reasoning_effort: reasoning_effort || session.reasoning_effort || undefined,
            working_directory: session.sdk_cwd || session.working_directory || undefined,
          },
        }
      : null;
    // Determine model: request override > session model > engine-specific default
    const effectiveModel = model
      || session.model
      || (resolvedEngineType === 'claude'
        ? (getSetting('default_model') || getCliDefaultsForEngine('claude').model)
        : getCliDefaultsForEngine(resolvedEngineType).model);
    const requestedReasoningEffort = reasoning_effort === undefined
      ? undefined
      : normalizeReasoningEffort(reasoning_effort);
    const sessionReasoningEffort = normalizeReasoningEffort(session.reasoning_effort);
    const effectiveReasoningEffort = resolvedEngineType === 'codex'
      ? (requestedReasoningEffort || sessionReasoningEffort || getCliDefaultsForEngine('codex').reasoningEffort)
      : undefined;
    const agentEngine = createAgentEngine({ engine: engine_type, session });
    const supportsPermissionMode = agentEngine.capabilities.includes('permission_mode');
    let engineSessionId = session.engine_session_id || session.sdk_session_id || undefined;

    const requestedEngineType = normalizeEngineType(engine_type || session.engine_type || 'claude');
    const hasExplicitModelOverride = typeof model === 'string' && model.trim().length > 0;
    const isRequestModelChange = hasExplicitModelOverride && model !== (session.model || '');
    const isRequestEngineChange = engine_type !== undefined
      && requestedEngineType !== normalizeEngineType(session.engine_type || 'claude');
    const isRequestProviderChange = provider_id !== undefined
      && provider_id !== (session.provider_id || '');
    if (
      engineSessionId
      && (isRequestModelChange || isRequestEngineChange || isRequestProviderChange)
    ) {
      // Model/provider/engine changes must start a fresh runtime thread.
      updateSdkSessionId(session_id, '');
      engineSessionId = undefined;
    }

    // Persist model and provider to session so usage stats can group by model+provider.
    // This runs on every message but the DB writes are cheap (single UPDATE by PK).
    if (effectiveModel && effectiveModel !== session.model) {
      updateSessionModel(session_id, effectiveModel);
    }
    if (requestedReasoningEffort !== undefined && requestedReasoningEffort !== (session.reasoning_effort || '')) {
      updateSessionReasoningEffort(session_id, requestedReasoningEffort);
    }

    // Resolve provider: explicit provider_id > default_provider_id > environment variables
    let resolvedProvider: import('@/types').ApiProvider | undefined;
    const effectiveProviderId = provider_id || session.provider_id || '';
    if (resolvedEngineType === 'codex' || resolvedEngineType === 'gemini') {
      // CLI runtimes do not use Claude-compatible provider fallback by default.
      if (effectiveProviderId && effectiveProviderId !== 'env') {
        resolvedProvider = getProvider(effectiveProviderId);
      }
    } else {
      if (effectiveProviderId && effectiveProviderId !== 'env') {
        resolvedProvider = getProvider(effectiveProviderId);
        if (!resolvedProvider) {
          // Requested provider not found, try default
          const defaultId = getDefaultProviderId();
          if (defaultId) {
            resolvedProvider = getProvider(defaultId);
          }
        }
      } else if (!effectiveProviderId) {
        // No provider specified, try default
        const defaultId = getDefaultProviderId();
        if (defaultId) {
          resolvedProvider = getProvider(defaultId);
        }
      }
    }
    // effectiveProviderId === 'env' → resolvedProvider stays undefined → uses env vars

    const providerName = resolvedProvider?.name || '';
    if (providerName !== (session.provider_name || '')) {
      updateSessionProvider(session_id, providerName);
    }
    const persistProviderId = resolvedEngineType === 'codex' || resolvedEngineType === 'gemini'
      ? (effectiveProviderId || 'env')
      : (effectiveProviderId || provider_id || '');
    if (persistProviderId !== (session.provider_id || '')) {
      updateSessionProviderId(session_id, persistProviderId);
    }

    // Determine permission mode from chat mode: code → acceptEdits, plan → plan, ask → default (no tools), yolo → bypassPermissions
    const effectiveMode = mode || session.mode || 'code';
    let requestedPermissionMode: string;
    let systemPromptOverride: string | undefined;
    switch (effectiveMode) {
      case 'plan':
        requestedPermissionMode = 'plan';
        break;
      case 'ask':
        requestedPermissionMode = 'default';
        systemPromptOverride = (session.system_prompt || '') +
          '\n\nYou are in Ask mode. Answer questions and provide information only. Do not use any tools, do not read or write files, do not execute commands. Only respond with text.';
        break;
      case 'yolo':
        requestedPermissionMode = 'bypassPermissions';
        break;
      default: // 'code'
        requestedPermissionMode = 'acceptEdits';
        break;
    }
    const permissionMode = supportsPermissionMode ? requestedPermissionMode : undefined;

    const abortController = new AbortController();

    // Handle client disconnect
    request.signal.addEventListener('abort', () => {
      abortController.abort();
    });

    // Convert file attachments to the format expected by engine adapters.
    // Include filePath from the already-saved files so engine clients can
    // reference the on-disk copies instead of writing them again.
    const fileAttachments: FileAttachment[] | undefined = files && files.length > 0
      ? files.map((f, i) => {
          const meta = fileMeta?.find((m: { id: string }) => m.id === f.id);
          return {
            id: f.id || `file-${Date.now()}-${i}`,
            name: f.name,
            type: f.type,
            size: f.size,
            data: (meta?.filePath && !f.type.startsWith('image/')) ? '' : f.data, // Keep base64 for images (needed for vision); clear for non-images (read from disk)
            filePath: meta?.filePath,
          };
        })
      : undefined;

    // Append per-request system prompt (e.g. skill injection for image generation)
    let finalSystemPrompt = systemPromptOverride || session.system_prompt || undefined;
    if (systemPromptAppend) {
      finalSystemPrompt = (finalSystemPrompt || '') + '\n\n' + systemPromptAppend;
    }

    // Load recent conversation history from DB as fallback context.
    // This is used when SDK session resume is unavailable or fails,
    // so the model still has conversation context.
    const { messages: recentMsgs } = getMessages(session_id, { limit: 50 });
    // Exclude the user message we just saved (last in the list) — it's already the prompt
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Stream via selected engine (request.engine_type > session.engine_type > claude default).
    console.log('[chat API] engine stream params:', {
      engineType: agentEngine.type,
      promptLength: content.length,
      promptFirst200: content.slice(0, 200),
      engineSessionId: engineSessionId || 'none',
      systemPromptLength: finalSystemPrompt?.length || 0,
      systemPromptFirst200: finalSystemPrompt?.slice(0, 200) || 'none',
    });
    const stream = nativeCommandRequest
      ? (resolvedEngineType === 'claude'
        ? streamClaudeNativeCommand(nativeCommandRequest)
        : streamCodexNativeCommand(nativeCommandRequest))
      : agentEngine.stream({
          prompt: content,
          sessionId: session_id,
          engineSessionId,
          model: effectiveModel,
          modelReasoningEffort: effectiveReasoningEffort || undefined,
          systemPrompt: finalSystemPrompt,
          workingDirectory: session.sdk_cwd || session.working_directory || undefined,
          workspaceTransport: session.workspace_transport,
          remoteConnectionId: session.remote_connection_id || undefined,
          remotePath: session.remote_path || undefined,
          abortController,
          permissionMode,
          files: fileAttachments,
          imageAgentMode: !!systemPromptAppend,
          toolTimeoutSeconds: toolTimeout || 300,
          provider: resolvedProvider,
          conversationHistory: historyMsgs,
          onRuntimeStatusChange: (status: string) => {
            try { setSessionRuntimeStatus(session_id, status); } catch { /* best effort */ }
          },
        });

    // Tee the stream: one for client, one for collecting the response
    const [streamForClient, streamForCollect] = stream.tee();

    // Periodically renew the session lock so long-running tasks don't expire
    const lockRenewalInterval = setInterval(() => {
      try { renewSessionLock(session_id, lockId, 600); } catch { /* best effort */ }
    }, 60_000);

    // Save assistant message in background, with cleanup callback to release lock
    collectStreamResponse(streamForCollect, session_id, telegramNotifyOpts, () => {
      clearInterval(lockRenewalInterval);
      releaseSessionLock(session_id, lockId);
      setSessionRuntimeStatus(session_id, 'idle');
    });

    return new Response(streamForClient, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    // Release lock and reset status on error (only if lock was acquired)
    if (activeSessionId && activeLockId) {
      try {
        releaseSessionLock(activeSessionId, activeLockId);
        setSessionRuntimeStatus(activeSessionId, 'idle', error instanceof Error ? error.message : 'Unknown error');
      } catch { /* best effort */ }
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function collectStreamResponse(
  stream: ReadableStream<string>,
  sessionId: string,
  telegramOpts: { sessionId?: string; sessionTitle?: string; workingDirectory?: string },
  onComplete?: () => void,
) {
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  let clearedInvalidResumeId = false;
  // Dedup layer: skip duplicate tool_result events by tool_use_id
  const seenToolResultIds = new Set<string>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event: SSEEvent = JSON.parse(line.slice(6));
            if (event.type === 'permission_request' || event.type === 'tool_output') {
              // Skip permission_request and tool_output events - not saved as message content
            } else if (event.type === 'text') {
              currentText += event.data;
            } else if (event.type === 'tool_use') {
              // Flush any accumulated text before the tool use block
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
              } catch {
                // skip malformed tool_use data
              }
            } else if (event.type === 'tool_result') {
              try {
                const resultData = JSON.parse(event.data);
                const newBlock = {
                  type: 'tool_result' as const,
                  tool_use_id: resultData.tool_use_id,
                  content: resultData.content,
                  is_error: resultData.is_error || false,
                };
                // Last-wins: if same tool_use_id already exists, replace it
                // (user handler's result may be more complete than PostToolUse's)
                if (seenToolResultIds.has(resultData.tool_use_id)) {
                  const idx = contentBlocks.findIndex(
                    (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                  );
                  if (idx >= 0) {
                    contentBlocks[idx] = newBlock;
                  }
                } else {
                  seenToolResultIds.add(resultData.tool_use_id);
                  contentBlocks.push(newBlock);
                }
              } catch {
                // skip malformed tool_result data
              }
            } else if (event.type === 'status') {
              // Capture SDK session_id and model from init event and persist them
              try {
                const statusData = JSON.parse(event.data);
                if (statusData.session_id) {
                  updateSdkSessionId(sessionId, statusData.session_id);
                }
                if (statusData.model) {
                  updateSessionModel(sessionId, statusData.model);
                }
              } catch {
                // skip malformed status data
              }
            } else if (event.type === 'task_update') {
              // Sync SDK TodoWrite tasks to local DB
              try {
                const taskData = JSON.parse(event.data);
                if (taskData.session_id && taskData.todos) {
                  syncSdkTasks(taskData.session_id, taskData.todos);
                }
              } catch {
                // skip malformed task_update data
              }
            } else if (event.type === 'mode_changed') {
              const nextMode = mapPermissionModeToSessionMode(event.data);
              if (nextMode) {
                updateSessionMode(sessionId, nextMode);
              }
            } else if (event.type === 'error') {
              hasError = true;
              errorMessage = event.data || 'Unknown error';
              if (!clearedInvalidResumeId && shouldResetCodexResumeOnError(errorMessage)) {
                try {
                  updateSdkSessionId(sessionId, '');
                  clearedInvalidResumeId = true;
                } catch {
                  // best effort
                }
              }
            } else if (event.type === 'result') {
              try {
                const resultData = JSON.parse(event.data);
                if (resultData.usage) {
                  tokenUsage = resultData.usage;
                }
                if (resultData.is_error) {
                  hasError = true;
                }
                // Also capture session_id from result if we missed it from init
                if (resultData.session_id) {
                  updateSdkSessionId(sessionId, resultData.session_id);
                }
              } catch {
                // skip malformed result data
              }
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    }

    // Flush any remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    if (contentBlocks.length > 0) {
      // If the message is text-only (no tool calls), store as plain text
      // for backward compatibility with existing message rendering.
      // If it contains tool calls, store as structured JSON.
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );

      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();

      if (content) {
        addMessage(
          sessionId,
          'assistant',
          content,
          tokenUsage ? JSON.stringify(tokenUsage) : null,
        );
      }
    }
  } catch (e) {
    hasError = true;
    errorMessage = e instanceof Error ? e.message : 'Stream reading error';
    if (!clearedInvalidResumeId && shouldResetCodexResumeOnError(errorMessage)) {
      try {
        updateSdkSessionId(sessionId, '');
        clearedInvalidResumeId = true;
      } catch {
        // best effort
      }
    }
    // Stream reading error - best effort save
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
            .join('')
            .trim();
      if (content) {
        addMessage(sessionId, 'assistant', content);
      }
    }
  } finally {
    // Telegram notifications: completion or error (fire-and-forget)
    if (hasError) {
      notifySessionError(errorMessage, telegramOpts).catch(() => {});
    } else {
      // Extract text summary for the completion notification
      const textSummary = contentBlocks
        .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      notifySessionComplete(textSummary || undefined, telegramOpts).catch(() => {});
    }
    onComplete?.();
  }
}
