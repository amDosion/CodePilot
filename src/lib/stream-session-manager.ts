/**
 * Stream Session Manager — client-side singleton that manages SSE streams
 * independently of React component lifecycle.
 *
 * When a user switches sessions, the old ChatView unmounts but the stream
 * continues running here. The new ChatView (or the same one re-mounted)
 * subscribes to get the current snapshot.
 *
 * Uses globalThis pattern (same as conversation-registry.ts) to survive
 * Next.js HMR without losing state.
 */

import { consumeSSEStream } from '@/hooks/useSSEStream';
import type {
  ToolUseInfo,
  ToolResultInfo,
  SessionStreamSnapshot,
  StreamEvent,
  StreamEventListener,
  FileAttachment,
} from '@/types';

// ==========================================
// Internal types
// ==========================================

interface ActiveStream {
  sessionId: string;
  generation: number;
  abortController: AbortController;
  snapshot: SessionStreamSnapshot;
  listeners: Set<StreamEventListener>;
  idleCheckTimer: ReturnType<typeof setInterval> | null;
  lastEventTime: number;
  gcTimer: ReturnType<typeof setTimeout> | null;
  // Mutable accumulators (snapshot gets new object refs on each emit)
  accumulatedText: string;
  toolUsesArray: ToolUseInfo[];
  toolResultsArray: ToolResultInfo[];
  toolOutputAccumulated: string;
  toolTimeoutInfo: { toolName: string; elapsedSeconds: number } | null;
  isIdleTimeout: boolean;
  stopRequestedByUser: boolean;
  sendMessageFn: ((content: string, files?: FileAttachment[]) => void) | null;
}

export interface StartStreamParams {
  sessionId: string;
  content: string;
  mode: string;
  model: string;
  reasoningEffort?: string;
  providerId: string;
  engineType: string;
  files?: FileAttachment[];
  systemPromptAppend?: string;
  pendingImageNotices?: string[];
  nativeCommand?: {
    commandName: string;
    args?: string;
  };
  /** Called when SDK mode changes (e.g. plan → code) */
  onModeChanged?: (mode: string) => void;
  /** Reference to the outer sendMessage so tool-timeout auto-retry works */
  sendMessageFn?: (content: string, files?: FileAttachment[]) => void;
}

// ==========================================
// Singleton via globalThis
// ==========================================

const GLOBAL_KEY = '__streamSessionManager__' as const;
const STREAM_IDLE_TIMEOUT_MS = 330_000;
const GC_DELAY_MS = 5 * 60 * 1000; // 5 minutes

function getStreamsMap(): Map<string, ActiveStream> {
  if (!(globalThis as Record<string, unknown>)[GLOBAL_KEY]) {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = new Map<string, ActiveStream>();
  }
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, ActiveStream>;
}

function isCurrentStream(stream: ActiveStream): boolean {
  const current = getStreamsMap().get(stream.sessionId);
  return current?.generation === stream.generation;
}

// ==========================================
// Helpers
// ==========================================

function buildSnapshot(stream: ActiveStream): SessionStreamSnapshot {
  return {
    sessionId: stream.sessionId,
    generation: stream.generation,
    phase: stream.snapshot.phase,
    streamingContent: stream.accumulatedText,
    toolUses: [...stream.toolUsesArray],
    toolResults: [...stream.toolResultsArray],
    streamingToolOutput: stream.toolOutputAccumulated,
    statusText: stream.snapshot.statusText,
    pendingPermission: stream.snapshot.pendingPermission,
    permissionResolved: stream.snapshot.permissionResolved,
    tokenUsage: stream.snapshot.tokenUsage,
    startedAt: stream.snapshot.startedAt,
    completedAt: stream.snapshot.completedAt,
    error: stream.snapshot.error,
    finalMessageContent: stream.snapshot.finalMessageContent,
  };
}

function emit(stream: ActiveStream, type: StreamEvent['type']) {
  if (!isCurrentStream(stream)) return;
  const snapshot = buildSnapshot(stream);
  stream.snapshot = snapshot; // store latest
  const event: StreamEvent = {
    type,
    sessionId: stream.sessionId,
    generation: stream.generation,
    snapshot,
  };
  for (const listener of stream.listeners) {
    try { listener(event); } catch { /* listener error */ }
  }
  // Also dispatch window event for AppShell
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('stream-session-event', { detail: event }));
  }
}

function scheduleGC(stream: ActiveStream) {
  if (stream.gcTimer) clearTimeout(stream.gcTimer);
  stream.gcTimer = setTimeout(() => {
    const map = getStreamsMap();
    const current = map.get(stream.sessionId);
    if (current === stream && current.snapshot.phase !== 'active') {
      map.delete(stream.sessionId);
    }
  }, GC_DELAY_MS);
  stream.gcTimer.unref?.();
}

function cleanupTimers(stream: ActiveStream) {
  if (stream.idleCheckTimer) {
    clearInterval(stream.idleCheckTimer);
    stream.idleCheckTimer = null;
  }
}

// ==========================================
// Public API
// ==========================================

export function startStream(params: StartStreamParams): void {
  const map = getStreamsMap();
  const existing = map.get(params.sessionId);
  const nextGeneration = (existing?.generation ?? 0) + 1;

  // If already streaming this session, abort old stream first
  if (existing && existing.snapshot.phase === 'active') {
    existing.stopRequestedByUser = true;
    existing.abortController.abort();
    cleanupTimers(existing);
  }

  const abortController = new AbortController();

  const stream: ActiveStream = {
    sessionId: params.sessionId,
    generation: nextGeneration,
    abortController,
    snapshot: {
      sessionId: params.sessionId,
      generation: nextGeneration,
      phase: 'active',
      streamingContent: '',
      toolUses: [],
      toolResults: [],
      streamingToolOutput: '',
      statusText: undefined,
      pendingPermission: null,
      permissionResolved: null,
      tokenUsage: null,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
      finalMessageContent: null,
    },
    listeners: existing?.listeners ?? new Set(),
    idleCheckTimer: null,
    lastEventTime: Date.now(),
    gcTimer: null,
    accumulatedText: '',
    toolUsesArray: [],
    toolResultsArray: [],
    toolOutputAccumulated: '',
    toolTimeoutInfo: null,
    isIdleTimeout: false,
    stopRequestedByUser: false,
    sendMessageFn: params.sendMessageFn ?? null,
  };

  map.set(params.sessionId, stream);
  emit(stream, 'phase-changed');

  // Run the stream in background (non-blocking)
  runStream(stream, params).catch(() => {});
}

async function runStream(stream: ActiveStream, params: StartStreamParams): Promise<void> {
  const markActive = (): boolean => {
    if (!isCurrentStream(stream)) return false;
    stream.lastEventTime = Date.now();
    return true;
  };

  // Idle timeout checker
  stream.idleCheckTimer = setInterval(() => {
    if (!isCurrentStream(stream)) {
      cleanupTimers(stream);
      return;
    }
    if (Date.now() - stream.lastEventTime >= STREAM_IDLE_TIMEOUT_MS) {
      cleanupTimers(stream);
      stream.isIdleTimeout = true;
      stream.stopRequestedByUser = false;
      stream.abortController.abort();
    }
  }, 10_000);

  // Flush pending image notices
  let effectiveContent = params.content;
  if (params.pendingImageNotices && params.pendingImageNotices.length > 0) {
    const notices = params.pendingImageNotices.join('\n\n');
    effectiveContent = `${notices}\n\n---\n\n${params.content}`;
  }

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: params.sessionId,
        content: effectiveContent,
        mode: params.mode,
        model: params.model,
        reasoning_effort: params.reasoningEffort || '',
        provider_id: params.providerId,
        engine_type: params.engineType,
        ...(params.files && params.files.length > 0 ? { files: params.files } : {}),
        ...(params.systemPromptAppend ? { systemPromptAppend: params.systemPromptAppend } : {}),
        ...(params.nativeCommand ? { native_command: { command_name: params.nativeCommand.commandName, ...(params.nativeCommand.args ? { args: params.nativeCommand.args } : {}) } } : {}),
      }),
      signal: stream.abortController.signal,
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to send message');
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response stream');

    const result = await consumeSSEStream(reader, {
      onText: (acc) => {
        if (!markActive()) return;
        stream.accumulatedText = acc;
        emit(stream, 'snapshot-updated');
      },
      onToolUse: (tool) => {
        if (!markActive()) return;
        stream.toolOutputAccumulated = '';
        if (!stream.toolUsesArray.some(t => t.id === tool.id)) {
          stream.toolUsesArray = [...stream.toolUsesArray, tool];
        }
        emit(stream, 'snapshot-updated');
      },
      onToolResult: (res) => {
        if (!markActive()) return;
        stream.toolOutputAccumulated = '';
        const existingIdx = stream.toolResultsArray.findIndex(r => r.tool_use_id === res.tool_use_id);
        if (existingIdx >= 0) {
          const next = [...stream.toolResultsArray];
          next[existingIdx] = res;
          stream.toolResultsArray = next;
        } else {
          stream.toolResultsArray = [...stream.toolResultsArray, res];
        }
        emit(stream, 'snapshot-updated');
        // Refresh file tree after each tool completes
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('refresh-file-tree'));
        }
      },
      onToolOutput: (data) => {
        if (!markActive()) return;
        const next = stream.toolOutputAccumulated + (stream.toolOutputAccumulated ? '\n' : '') + data;
        stream.toolOutputAccumulated = next.length > 5000 ? next.slice(-5000) : next;
        emit(stream, 'snapshot-updated');
      },
      onToolProgress: (toolName, elapsed) => {
        if (!markActive()) return;
        stream.snapshot = { ...stream.snapshot, statusText: `Running ${toolName}... (${elapsed}s)` };
        emit(stream, 'snapshot-updated');
      },
      onStatus: (text) => {
        if (!markActive()) return;
        if (text?.startsWith('Connected (')) {
          stream.snapshot = { ...stream.snapshot, statusText: text };
          emit(stream, 'snapshot-updated');
          setTimeout(() => {
            // Only clear if still the same status
            if (isCurrentStream(stream) && stream.snapshot.statusText === text) {
              stream.snapshot = { ...stream.snapshot, statusText: undefined };
              emit(stream, 'snapshot-updated');
            }
          }, 2000);
        } else {
          stream.snapshot = { ...stream.snapshot, statusText: text };
          emit(stream, 'snapshot-updated');
        }
      },
      onResult: (usage) => {
        if (!markActive()) return;
        stream.snapshot = { ...stream.snapshot, tokenUsage: usage };
      },
      onPermissionRequest: (permData) => {
        if (!markActive()) return;
        stream.snapshot = {
          ...stream.snapshot,
          pendingPermission: permData,
          permissionResolved: null,
        };
        emit(stream, 'permission-request');
      },
      onToolTimeout: (toolName, elapsedSeconds) => {
        if (!markActive()) return;
        stream.toolTimeoutInfo = { toolName, elapsedSeconds };
      },
      onModeChanged: (sdkMode) => {
        if (!markActive()) return;
        if (params.onModeChanged) {
          params.onModeChanged(sdkMode);
        }
      },
      onTaskUpdate: () => {
        if (!markActive()) return;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('tasks-updated'));
        }
      },
      onKeepAlive: () => {
        markActive();
      },
      onError: (acc) => {
        if (!markActive()) return;
        stream.accumulatedText = acc;
        emit(stream, 'snapshot-updated');
      },
    });

    if (!isCurrentStream(stream)) {
      cleanupTimers(stream);
      return;
    }

    // Stream completed successfully — build final message content
    const accumulated = result.accumulated;
    const finalToolUses = stream.toolUsesArray;
    const finalToolResults = stream.toolResultsArray;
    const hasTools = finalToolUses.length > 0 || finalToolResults.length > 0;

    let messageContent = accumulated.trim();
    if (hasTools && messageContent) {
      const contentBlocks: Array<Record<string, unknown>> = [];
      if (accumulated.trim()) {
        contentBlocks.push({ type: 'text', text: accumulated.trim() });
      }
      for (const tu of finalToolUses) {
        contentBlocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
        const tr = finalToolResults.find(r => r.tool_use_id === tu.id);
        if (tr) {
          contentBlocks.push({ type: 'tool_result', tool_use_id: tr.tool_use_id, content: tr.content });
        }
      }
      messageContent = JSON.stringify(contentBlocks);
    }

    // Update snapshot with completion info
    stream.snapshot = {
      ...buildSnapshot(stream),
      phase: 'completed',
      completedAt: Date.now(),
      tokenUsage: result.tokenUsage,
      finalMessageContent: messageContent || null,
      statusText: undefined,
      pendingPermission: null,
      permissionResolved: null,
    };
    stream.accumulatedText = '';
    stream.toolUsesArray = [];
    stream.toolResultsArray = [];
    stream.toolOutputAccumulated = '';

    cleanupTimers(stream);
    emit(stream, 'completed');
    scheduleGC(stream);

    // Refresh file tree after completion
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('refresh-file-tree'));
    }

  } catch (error) {
    cleanupTimers(stream);
    if (!isCurrentStream(stream)) {
      return;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      if (stream.isIdleTimeout) {
        // Idle timeout
        const idleSecs = Math.round(STREAM_IDLE_TIMEOUT_MS / 1000);
        const errContent = stream.accumulatedText.trim()
          ? stream.accumulatedText.trim() + `\n\n**Error:** Stream idle timeout — no response for ${idleSecs}s. The connection may have dropped.`
          : `**Error:** Stream idle timeout — no response for ${idleSecs}s. The connection may have dropped.`;

        stream.snapshot = {
          ...buildSnapshot(stream),
          phase: 'error',
          completedAt: Date.now(),
          error: `Stream idle timeout (${idleSecs}s)`,
          finalMessageContent: errContent,
          statusText: undefined,
          pendingPermission: null,
          permissionResolved: null,
        };
        stream.accumulatedText = '';
        stream.toolUsesArray = [];
        stream.toolResultsArray = [];
        stream.toolOutputAccumulated = '';
        emit(stream, 'completed');
        scheduleGC(stream);
      } else if (stream.stopRequestedByUser) {
        // User manually stopped — add partial content with "(generation stopped)"
        const partialContent = stream.accumulatedText.trim()
          ? stream.accumulatedText.trim() + '\n\n*(generation stopped)*'
          : null;

        stream.snapshot = {
          ...buildSnapshot(stream),
          phase: 'stopped',
          completedAt: Date.now(),
          finalMessageContent: partialContent,
          statusText: undefined,
          pendingPermission: null,
          permissionResolved: null,
        };
        stream.accumulatedText = '';
        stream.toolUsesArray = [];
        stream.toolResultsArray = [];
        stream.toolOutputAccumulated = '';
        stream.stopRequestedByUser = false;
        emit(stream, 'completed');
        scheduleGC(stream);
      } else if (stream.toolTimeoutInfo) {
        // Tool timeout — auto-retry
        const timeoutInfo = stream.toolTimeoutInfo;
        const partialContent = stream.accumulatedText.trim()
          ? stream.accumulatedText.trim() + `\n\n*(tool ${timeoutInfo.toolName} timed out after ${timeoutInfo.elapsedSeconds}s)*`
          : null;

        stream.snapshot = {
          ...buildSnapshot(stream),
          phase: 'stopped',
          completedAt: Date.now(),
          finalMessageContent: partialContent,
          statusText: undefined,
          pendingPermission: null,
          permissionResolved: null,
        };
        stream.accumulatedText = '';
        stream.toolUsesArray = [];
        stream.toolResultsArray = [];
        stream.toolOutputAccumulated = '';
        stream.toolTimeoutInfo = null;
        stream.stopRequestedByUser = false;
        emit(stream, 'completed');
        scheduleGC(stream);

        // Auto-retry via sendMessageFn
        if (stream.sendMessageFn) {
          const fn = stream.sendMessageFn;
          setTimeout(() => {
            fn(
              `The previous tool "${timeoutInfo.toolName}" timed out after ${timeoutInfo.elapsedSeconds} seconds. Please try a different approach to accomplish the task. Avoid repeating the same operation that got stuck.`
            );
          }, 500);
        }
      } else {
        // User manually stopped — add partial content with "(generation stopped)"
        const partialContent = stream.accumulatedText.trim()
          ? stream.accumulatedText.trim() + '\n\n*(generation stopped)*'
          : null;

        stream.snapshot = {
          ...buildSnapshot(stream),
          phase: 'stopped',
          completedAt: Date.now(),
          finalMessageContent: partialContent,
          statusText: undefined,
          pendingPermission: null,
          permissionResolved: null,
        };
        stream.accumulatedText = '';
        stream.toolUsesArray = [];
        stream.toolResultsArray = [];
        stream.toolOutputAccumulated = '';
        stream.stopRequestedByUser = false;
        emit(stream, 'completed');
        scheduleGC(stream);
      }
    } else {
      // Non-abort error
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      stream.snapshot = {
        ...buildSnapshot(stream),
        phase: 'error',
        completedAt: Date.now(),
        error: errMsg,
        finalMessageContent: `**Error:** ${errMsg}`,
        statusText: undefined,
        pendingPermission: null,
        permissionResolved: null,
      };
      stream.accumulatedText = '';
      stream.toolUsesArray = [];
      stream.toolResultsArray = [];
      stream.toolOutputAccumulated = '';
      emit(stream, 'completed');
      scheduleGC(stream);
    }
  }
}

// ==========================================
// Stop
// ==========================================

export function stopStream(sessionId: string): void {
  const stream = getStreamsMap().get(sessionId);
  if (stream && stream.snapshot.phase === 'active') {
    stream.stopRequestedByUser = true;
    stream.abortController.abort();
  }
}

// ==========================================
// Subscribe
// ==========================================

export function subscribe(sessionId: string, listener: StreamEventListener): () => void {
  const map = getStreamsMap();
  let stream = map.get(sessionId);

  if (!stream) {
    // Create a placeholder entry to hold listeners even when no stream is active
    stream = {
      sessionId,
      generation: 0,
      abortController: new AbortController(),
      snapshot: {
        sessionId,
        generation: 0,
        phase: 'completed' as const,
        streamingContent: '',
        toolUses: [],
        toolResults: [],
        streamingToolOutput: '',
        statusText: undefined,
        pendingPermission: null,
        permissionResolved: null,
        tokenUsage: null,
        startedAt: 0,
        completedAt: null,
        error: null,
        finalMessageContent: null,
      },
      listeners: new Set(),
      idleCheckTimer: null,
      lastEventTime: 0,
      gcTimer: null,
      accumulatedText: '',
      toolUsesArray: [],
      toolResultsArray: [],
      toolOutputAccumulated: '',
      toolTimeoutInfo: null,
      isIdleTimeout: false,
      stopRequestedByUser: false,
      sendMessageFn: null,
    };
    map.set(sessionId, stream);
  }

  stream.listeners.add(listener);

  return () => {
    stream!.listeners.delete(listener);
  };
}

// ==========================================
// Snapshot access
// ==========================================

export function getSnapshot(sessionId: string): SessionStreamSnapshot | null {
  const stream = getStreamsMap().get(sessionId);
  if (!stream) return null;
  // Don't return stale placeholder entries
  if (stream.snapshot.startedAt === 0) return null;
  return stream.snapshot;
}

export function isStreamActive(sessionId: string): boolean {
  const stream = getStreamsMap().get(sessionId);
  return stream?.snapshot.phase === 'active' || false;
}

export function getActiveSessionIds(): string[] {
  const ids: string[] = [];
  for (const [id, stream] of getStreamsMap()) {
    if (stream.snapshot.phase === 'active') {
      ids.push(id);
    }
  }
  return ids;
}

// ==========================================
// Permission response
// ==========================================

export async function respondToPermission(
  sessionId: string,
  decision: 'allow' | 'allow_session' | 'deny',
  updatedInput?: Record<string, unknown>,
  denyMessage?: string,
): Promise<void> {
  const stream = getStreamsMap().get(sessionId);
  if (!stream || !stream.snapshot.pendingPermission) return;

  const perm = stream.snapshot.pendingPermission;

  const body = {
    permissionRequestId: perm.permissionRequestId,
    decision: decision === 'deny'
      ? { behavior: 'deny' as const, message: denyMessage || 'User denied permission' }
      : {
          behavior: 'allow' as const,
          ...(decision === 'allow_session' && perm.suggestions
            ? { updatedPermissions: perm.suggestions }
            : {}),
          ...(updatedInput ? { updatedInput } : {}),
        },
  };

  // Update snapshot immediately
  stream.snapshot = {
    ...stream.snapshot,
    permissionResolved: decision === 'deny' ? 'deny' : 'allow',
  };
  emit(stream, 'snapshot-updated');

  try {
    await fetch('/api/chat/permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Best effort
  }

  // Clear permission state after delay (only if no new request arrived)
  const answeredId = perm.permissionRequestId;
  setTimeout(() => {
    if (stream.snapshot.pendingPermission?.permissionRequestId === answeredId) {
      stream.snapshot = {
        ...stream.snapshot,
        pendingPermission: null,
        permissionResolved: null,
      };
      emit(stream, 'snapshot-updated');
    }
  }, 1000);
}

// ==========================================
// Cleanup
// ==========================================

export function clearSnapshot(sessionId: string, generation?: number): void {
  const stream = getStreamsMap().get(sessionId);
  if (stream && stream.snapshot.phase !== 'active') {
    if (typeof generation === 'number' && stream.generation !== generation) {
      return;
    }
    if (stream.gcTimer) clearTimeout(stream.gcTimer);
    // Keep the listeners entry but reset the snapshot
    stream.snapshot = {
      ...stream.snapshot,
      startedAt: 0,
      finalMessageContent: null,
    };
  }
}
