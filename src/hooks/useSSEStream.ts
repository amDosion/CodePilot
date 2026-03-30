import { useRef, useCallback } from 'react';
import type { SSEEvent, TokenUsage, PermissionRequestEvent } from '@/types';

interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultInfo {
  tool_use_id: string;
  content: string;
}

export interface SSECallbacks {
  onText: (accumulated: string) => void;
  onToolUse: (tool: ToolUseInfo) => void;
  onToolResult: (result: ToolResultInfo) => void;
  onToolOutput: (data: string) => void;
  onToolProgress: (toolName: string, elapsedSeconds: number) => void;
  onStatus: (text: string | undefined) => void;
  onResult: (usage: TokenUsage | null) => void;
  onPermissionRequest: (data: PermissionRequestEvent) => void;
  onToolTimeout: (toolName: string, elapsedSeconds: number) => void;
  onModeChanged: (mode: string) => void;
  onTaskUpdate: (sessionId: string) => void;
  onKeepAlive: () => void;
  onError: (accumulated: string) => void;
}

/**
 * Parse a single SSE line (after stripping "data: " prefix) and dispatch
 * to the appropriate callback.  Returns the updated accumulated text.
 */
function handleSSEEvent(
  event: SSEEvent,
  accumulated: string,
  callbacks: SSECallbacks,
): { accumulated: string; done: boolean } {
  switch (event.type) {
    case 'text': {
      const next = accumulated + event.data;
      callbacks.onText(next);
      return { accumulated: next, done: false };
    }

    case 'tool_use': {
      try {
        const toolData = JSON.parse(event.data);
        callbacks.onToolUse({
          id: toolData.id,
          name: toolData.name,
          input: toolData.input,
        });
      } catch {
        // skip malformed tool_use data
      }
      return { accumulated, done: false };
    }

    case 'tool_result': {
      try {
        const resultData = JSON.parse(event.data);
        callbacks.onToolResult({
          tool_use_id: resultData.tool_use_id,
          content: resultData.content,
        });
      } catch {
        // skip malformed tool_result data
      }
      return { accumulated, done: false };
    }

    case 'tool_output': {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed._progress) {
          callbacks.onToolProgress(parsed.tool_name, Math.round(parsed.elapsed_time_seconds));
          return { accumulated, done: false };
        }
      } catch {
        // Not JSON - raw stderr output, fall through
      }
      callbacks.onToolOutput(event.data);
      return { accumulated, done: false };
    }

    case 'status': {
      try {
        const statusData = JSON.parse(event.data);
        if (statusData.session_id) {
          callbacks.onStatus(`Connected (${statusData.model || 'claude'})`);
        } else if (statusData.notification) {
          callbacks.onStatus(statusData.message || statusData.title || undefined);
        } else {
          callbacks.onStatus(typeof event.data === 'string' ? event.data : undefined);
        }
      } catch {
        callbacks.onStatus(event.data || undefined);
      }
      return { accumulated, done: false };
    }

    case 'result': {
      try {
        const resultData = JSON.parse(event.data);
        callbacks.onResult(resultData.usage || null);
      } catch {
        callbacks.onResult(null);
      }
      callbacks.onStatus(undefined);
      return { accumulated, done: false };
    }

    case 'permission_request': {
      try {
        const permData: PermissionRequestEvent = JSON.parse(event.data);
        callbacks.onPermissionRequest(permData);
      } catch {
        // skip malformed permission_request data
      }
      return { accumulated, done: false };
    }

    case 'tool_timeout': {
      try {
        const timeoutData = JSON.parse(event.data);
        callbacks.onToolTimeout(timeoutData.tool_name, timeoutData.elapsed_seconds);
      } catch {
        // skip malformed timeout data
      }
      return { accumulated, done: false };
    }

    case 'mode_changed': {
      callbacks.onModeChanged(event.data);
      return { accumulated, done: false };
    }

    case 'task_update': {
      try {
        const taskData = JSON.parse(event.data);
        callbacks.onTaskUpdate(taskData.session_id);
      } catch {
        // skip malformed task_update data
      }
      return { accumulated, done: false };
    }

    case 'keep_alive': {
      callbacks.onKeepAlive();
      return { accumulated, done: false };
    }

    case 'error': {
      const next = accumulated + '\n\n**Error:** ' + event.data;
      callbacks.onError(next);
      return { accumulated: next, done: false };
    }

    case 'done': {
      return { accumulated, done: true };
    }

    default:
      return { accumulated, done: false };
  }
}

/**
 * Reads an SSE response body and dispatches parsed events through callbacks.
 * Returns the final accumulated text and token usage.
 */
export async function consumeSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: SSECallbacks,
): Promise<{ accumulated: string; tokenUsage: TokenUsage | null }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let tokenUsage: TokenUsage | null = null;
  let streamDone = false;

  const wrappedCallbacks: SSECallbacks = {
    ...callbacks,
    onResult: (usage) => {
      tokenUsage = usage;
      callbacks.onResult(usage);
    },
  };

  while (true) {
    if (streamDone) break;
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (!line.startsWith('data: ')) continue;

      try {
        const event: SSEEvent = JSON.parse(line.slice(6));
        const next = handleSSEEvent(event, accumulated, wrappedCallbacks);
        accumulated = next.accumulated;
        if (next.done) {
          streamDone = true;
          break;
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }

  return { accumulated, tokenUsage };
}

/**
 * Hook that provides a stable consumeSSEStream function bound to the latest
 * callbacks via a ref, avoiding stale closures.
 */
export function useSSEStream() {
  const callbacksRef = useRef<SSECallbacks | null>(null);

  const processStream = useCallback(
    async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      callbacks: SSECallbacks,
    ) => {
      callbacksRef.current = callbacks;

      // Proxy through ref so callers always hit the latest callbacks
      const proxied: SSECallbacks = {
        onText: (a) => callbacksRef.current?.onText(a),
        onToolUse: (t) => callbacksRef.current?.onToolUse(t),
        onToolResult: (r) => callbacksRef.current?.onToolResult(r),
        onToolOutput: (d) => callbacksRef.current?.onToolOutput(d),
        onToolProgress: (n, s) => callbacksRef.current?.onToolProgress(n, s),
        onStatus: (t) => callbacksRef.current?.onStatus(t),
        onResult: (u) => callbacksRef.current?.onResult(u),
        onPermissionRequest: (d) => callbacksRef.current?.onPermissionRequest(d),
        onToolTimeout: (n, s) => callbacksRef.current?.onToolTimeout(n, s),
        onModeChanged: (m) => callbacksRef.current?.onModeChanged(m),
        onTaskUpdate: (s) => callbacksRef.current?.onTaskUpdate(s),
        onKeepAlive: () => callbacksRef.current?.onKeepAlive(),
        onError: (a) => callbacksRef.current?.onError(a),
      };

      return consumeSSEStream(reader, proxied);
    },
    [],
  );

  return { processStream };
}
