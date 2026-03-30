import { getSession } from '@/lib/db';
import type {
  CodexAppServerClient,
  CodexAppServerNotification,
} from '@/lib/codex-app-server-client';
import { withCodexAppServer } from '@/lib/codex-app-server-client';
import type { NativeCommandControllerRequest, SSEEvent } from '@/types';

const STREAM_NATIVE_COMMAND_NAMES = new Set(['compact', 'review']);

type WithCodexAppServer = typeof withCodexAppServer;

type RunnerDeps = {
  withCodexAppServer: WithCodexAppServer;
  getSession: typeof getSession;
};

type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title: string | null }
  | { type: 'custom'; instructions: string };

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function buildErrorStream(message: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(formatSSE({ type: 'error', data: message }));
      controller.enqueue(formatSSE({ type: 'done', data: '' }));
      controller.close();
    },
  });
}

function toToolResultContent(item: Record<string, unknown>): string {
  if (item.type === 'commandExecution') {
    const output = getString(item.aggregatedOutput);
    if (output) return output;
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
    return exitCode === null ? 'Command finished.' : `Command exited with code ${exitCode}.`;
  }

  if (item.type === 'mcpToolCall') {
    const error = isRecord(item.error) ? item.error : null;
    if (error && getString(error.message)) {
      return getString(error.message);
    }

    const result = isRecord(item.result) ? item.result : null;
    if (!result) return '';

    const content = Array.isArray(result.content) ? result.content : [];
    const textContent = content
      .map((block) => {
        if (!isRecord(block)) return '';
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        return JSON.stringify(block);
      })
      .filter(Boolean)
      .join('\n')
      .trim();

    if (textContent) return textContent;
    if (result.structuredContent !== undefined) {
      try {
        return JSON.stringify(result.structuredContent);
      } catch {
        return String(result.structuredContent);
      }
    }
  }

  return '';
}

function buildReviewTarget(args?: string): ReviewTarget {
  const trimmed = (args || '').trim();
  if (!trimmed) {
    return { type: 'uncommittedChanges' };
  }

  const baseMatch = trimmed.match(/^(?:base|branch)\s*[:=]\s*(.+)$/i) || trimmed.match(/^--base\s+(.+)$/i);
  if (baseMatch?.[1]) {
    return { type: 'baseBranch', branch: baseMatch[1].trim() };
  }

  const commitMatch = trimmed.match(/^(?:commit|sha)\s*[:=]\s*([0-9a-f]{7,40})$/i);
  if (commitMatch?.[1]) {
    return { type: 'commit', sha: commitMatch[1], title: null };
  }

  return { type: 'custom', instructions: trimmed };
}

export function isCodexStreamNativeCommand(commandName: string): boolean {
  return STREAM_NATIVE_COMMAND_NAMES.has(commandName.trim().toLowerCase());
}

export function createCodexNativeCommandStreamRunner(deps: RunnerDeps = {
  withCodexAppServer,
  getSession,
}) {
  return function streamCodexNativeCommand(request: NativeCommandControllerRequest): ReadableStream<string> {
    const commandName = request.command_name.trim().toLowerCase();
    if (!isCodexStreamNativeCommand(commandName)) {
      return buildErrorStream(`Unsupported Codex streaming command: /${commandName}`);
    }

    if (request.engine_type !== 'codex') {
      return buildErrorStream(`Codex streaming command /${commandName} is unavailable for engine "${request.engine_type}".`);
    }

    if (!request.session_id) {
      return buildErrorStream(`Codex command /${commandName} requires an active conversation.`);
    }

    const session = deps.getSession(request.session_id);
    if (!session) {
      return buildErrorStream('Session not found.');
    }

    const threadId = session.engine_session_id || session.sdk_session_id || '';
    if (!threadId) {
      return buildErrorStream(`Codex command /${commandName} requires an active Codex thread.`);
    }

    const workingDirectory = request.context?.working_directory || session.working_directory || undefined;
    const currentModel = request.context?.model || session.model || undefined;
    const currentProviderId = request.context?.provider_id || session.provider_id || 'env';

    return new ReadableStream<string>({
      async start(controller) {
        const emit = (event: SSEEvent) => {
          controller.enqueue(formatSSE(event));
        };

        const emitStatus = (text: string) => {
          emit({
            type: 'status',
            data: JSON.stringify({ notification: true, message: text }),
          });
        };

        let completed = false;
        let activeTurnId = '';
        let targetThreadId = threadId;
        let assistantText = '';
        let settleWait: (() => void) | null = null;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const emittedToolUse = new Set<string>();

        const resolveWait = () => {
          const next = settleWait;
          settleWait = null;
          next?.();
        };

        const finish = (usage: Record<string, unknown> | null = null) => {
          if (completed) return;
          completed = true;
          emit({
            type: 'result',
            data: JSON.stringify({
              usage,
              session_id: threadId,
            }),
          });
          emit({ type: 'done', data: '' });
          controller.close();
          resolveWait();
        };

        const fail = (message: string) => {
          if (completed) return;
          completed = true;
          emit({ type: 'error', data: message });
          emit({ type: 'done', data: '' });
          controller.close();
          resolveWait();
        };

        const matchesTurn = (payload: Record<string, unknown>) => {
          const payloadThreadId = getString(payload.threadId);
          if (payloadThreadId && payloadThreadId !== targetThreadId) {
            return false;
          }

          const payloadTurnId = getString(payload.turnId);
          if (!activeTurnId) {
            if (payloadTurnId) {
              activeTurnId = payloadTurnId;
            }
            return true;
          }
          return !payloadTurnId || payloadTurnId === activeTurnId;
        };

        const emitToolUse = (item: Record<string, unknown>) => {
          const itemId = getString(item.id);
          if (!itemId || emittedToolUse.has(itemId)) return;

          if (item.type === 'commandExecution') {
            emittedToolUse.add(itemId);
            emit({
              type: 'tool_use',
              data: JSON.stringify({
                id: itemId,
                name: 'command_execution',
                input: { command: getString(item.command) },
              }),
            });
            return;
          }

          if (item.type === 'mcpToolCall') {
            emittedToolUse.add(itemId);
            emit({
              type: 'tool_use',
              data: JSON.stringify({
                id: itemId,
                name: `mcp:${getString(item.server)}/${getString(item.tool)}`,
                input: item.arguments,
              }),
            });
          }
        };

        try {
          await deps.withCodexAppServer(async (client: CodexAppServerClient) => {
            const unsubscribe = client.subscribeNotifications((notification: CodexAppServerNotification) => {
              if (completed) return;
              const payload = isRecord(notification.params) ? notification.params : null;
              if (!payload) return;

              if (notification.method === 'turn/started') {
                const payloadThreadId = getString(payload.threadId);
                if (payloadThreadId && payloadThreadId !== targetThreadId) {
                  return;
                }
                const turn = isRecord(payload.turn) ? payload.turn : null;
                const turnId = turn ? getString(turn.id) : '';
                if (turnId) {
                  activeTurnId = turnId;
                }
                return;
              }

              if (!matchesTurn(payload)) {
                return;
              }

              if (notification.method === 'item/agentMessage/delta') {
                const delta = getString(payload.delta);
                if (delta) {
                  assistantText += delta;
                  emit({ type: 'text', data: delta });
                }
                return;
              }

              if (notification.method === 'item/commandExecution/outputDelta') {
                const delta = getString(payload.delta);
                if (delta) {
                  emit({ type: 'tool_output', data: delta });
                }
                return;
              }

              if (notification.method === 'item/mcpToolCall/progress') {
                const progress = getString(payload.message);
                if (progress) {
                  emit({ type: 'tool_output', data: progress });
                }
                return;
              }

              if (notification.method === 'item/started' || notification.method === 'item/completed') {
                const item = isRecord(payload.item) ? payload.item : null;
                if (!item || typeof item.type !== 'string') {
                  return;
                }

                emitToolUse(item);

                if (notification.method === 'item/completed') {
                  if (item.type === 'agentMessage') {
                    const text = getString(item.text);
                    if (text && text.startsWith(assistantText)) {
                      const missing = text.slice(assistantText.length);
                      if (missing) {
                        assistantText = text;
                        emit({ type: 'text', data: missing });
                      }
                    } else if (text && text !== assistantText) {
                      assistantText = text;
                    }
                    return;
                  }

                  if (item.type === 'exitedReviewMode') {
                    const reviewText = getString(item.review);
                    if (reviewText) {
                      const missing = reviewText.startsWith(assistantText)
                        ? reviewText.slice(assistantText.length)
                        : reviewText;
                      if (missing) {
                        assistantText = reviewText;
                        emit({ type: 'text', data: missing });
                      }
                    }
                    return;
                  }

                  if (item.type === 'commandExecution' || item.type === 'mcpToolCall') {
                    const itemId = getString(item.id);
                    if (itemId) {
                      emit({
                        type: 'tool_result',
                        data: JSON.stringify({
                          tool_use_id: itemId,
                          content: toToolResultContent(item),
                          is_error: getString(item.status) === 'failed' || Boolean(item.error),
                        }),
                      });
                    }
                  }
                }
                return;
              }

              if (notification.method === 'turn/completed') {
                const turn = isRecord(payload.turn) ? payload.turn : null;
                const turnId = turn ? getString(turn.id) : '';
                if (activeTurnId && turnId && turnId !== activeTurnId) {
                  return;
                }
                finish();
              }
            });

            timeoutHandle = setTimeout(() => {
              unsubscribe();
              fail(`Codex command /${commandName} timed out.`);
            }, commandName === 'review' ? 120_000 : 45_000);
            timeoutHandle.unref?.();

            try {
              emit({
                type: 'status',
                data: JSON.stringify({ session_id: threadId, model: currentModel || '' }),
              });
              emitStatus(`Running /${commandName}...`);

              await client.resumeThread({
                threadId,
                cwd: workingDirectory,
                model: currentModel || null,
                modelProvider: currentProviderId === 'env' ? null : currentProviderId,
                persistExtendedHistory: false,
              });

              if (commandName === 'compact') {
                await client.compactThread({ threadId });
              } else {
                const review = await client.startReview({
                  threadId,
                  delivery: 'inline',
                  target: buildReviewTarget(request.args),
                });
                targetThreadId = review.reviewThreadId || threadId;
                if (review.turn?.id) {
                  activeTurnId = review.turn.id;
                }
              }

              if (!completed) {
                await new Promise<void>((resolve) => {
                  settleWait = resolve;
                });
              }
            } finally {
              unsubscribe();
              if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
              }
            }
          });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      },
    });
  };
}

export const streamCodexNativeCommand = createCodexNativeCommandStreamRunner();
