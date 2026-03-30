import {
  Codex,
  type AgentMessageItem,
  type CodexOptions,
  type CommandExecutionItem,
  type ErrorItem,
  type FileChangeItem,
  type Input,
  type McpToolCallItem,
  type ThreadItem,
  type ThreadOptions,
  type TodoListItem,
  type Usage,
  type UserInput,
  type WebSearchItem,
} from '@openai/codex-sdk';
import type { ApiProvider, FileAttachment, SSEEvent, TokenUsage } from '@/types';
import fs from 'fs';
import os from 'os';
import { resolveCodexCliPath } from '@/lib/codex-cli';
import type { AgentEngine, EngineCapability, EngineStreamOptions } from './types';
import { streamRemoteCodex } from './codex-remote-stream';

const CODEX_CAPABILITIES: readonly EngineCapability[] = [
  'streaming',
  'session_resume',
  'mcp',
  'vision',
  'tool_calling',
];

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function toTokenUsage(usage: Usage): TokenUsage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cached_input_tokens,
    cache_creation_input_tokens: 0,
  };
}

function toCodexOptions(provider?: ApiProvider, overrides: Partial<CodexOptions> = {}): CodexOptions {
  const options: CodexOptions = { ...overrides };
  const pathOverride = resolveCodexCliPath();
  if (!options.codexPathOverride && pathOverride) options.codexPathOverride = pathOverride;
  if (provider?.api_key) options.apiKey = provider.api_key;
  if (provider?.base_url) options.baseUrl = provider.base_url;
  return options;
}

function toThreadOptions(options: EngineStreamOptions, workingDirectory?: string): ThreadOptions {
  const threadOptions: ThreadOptions = {
    workingDirectory: workingDirectory || options.workingDirectory || os.homedir(),
    skipGitRepoCheck: true,
  };

  if (options.model) {
    threadOptions.model = options.model;
  }
  if (options.modelReasoningEffort) {
    threadOptions.modelReasoningEffort = options.modelReasoningEffort as ThreadOptions['modelReasoningEffort'];
  }

  return threadOptions;
}

function resolveAttachmentPath(
  file: FileAttachment,
  attachmentPaths?: Map<string, string>,
): string | null {
  const staged = attachmentPaths?.get(file.id);
  if (staged) return staged;
  if (!file.filePath) return null;
  return fs.existsSync(file.filePath) ? file.filePath : null;
}

function summarizeAssistantHistoryContent(content: string): string {
  if (!content.startsWith('[')) return content;
  try {
    const blocks = JSON.parse(content);
    if (!Array.isArray(blocks)) return content;

    const parts: string[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if ('type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        parts.push(block.text);
      } else if ('type' in block && block.type === 'tool_use' && 'name' in block && typeof block.name === 'string') {
        parts.push(`[Used tool: ${block.name}]`);
      } else if ('type' in block && block.type === 'tool_result' && 'content' in block) {
        const resultStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        parts.push(`[Tool result: ${resultStr.slice(0, 500)}${resultStr.length > 500 ? '...' : ''}]`);
      }
    }
    return parts.join('\n');
  } catch {
    return content;
  }
}

function buildCodexPrompt(options: EngineStreamOptions, useHistory: boolean): string {
  const lines: string[] = [];

  if (options.systemPrompt?.trim()) {
    lines.push('<system_instructions>');
    lines.push(options.systemPrompt.trim());
    lines.push('</system_instructions>');
    lines.push('');
  }

  if (useHistory && options.conversationHistory && options.conversationHistory.length > 0) {
    lines.push('<conversation_history>');
    for (const msg of options.conversationHistory) {
      const roleLabel = msg.role === 'user' ? 'Human' : 'Assistant';
      const content = msg.role === 'assistant'
        ? summarizeAssistantHistoryContent(msg.content)
        : msg.content;
      lines.push(`${roleLabel}: ${content}`);
    }
    lines.push('</conversation_history>');
    lines.push('');
  }

  lines.push(options.prompt);
  return lines.join('\n');
}

function toCodexInput(options: EngineStreamOptions, useHistory: boolean): Input {
  const promptText = buildCodexPrompt(options, useHistory);
  const files = options.files || [];
  if (files.length === 0) return promptText;

  const content: UserInput[] = [];
  const fileReferences: string[] = [];

  for (const file of files) {
    const attachmentPath = resolveAttachmentPath(file);
    if (attachmentPath && file.type.startsWith('image/')) {
      content.push({ type: 'local_image', path: attachmentPath });
      continue;
    }

    if (attachmentPath) {
      fileReferences.push(`[User attached file: ${attachmentPath} (${file.name})]`);
    } else {
      fileReferences.push(`[User attached file: ${file.name}]`);
    }
  }

  if (fileReferences.length > 0) {
    content.unshift({
      type: 'text',
      text: `${fileReferences.join('\n')}\n\n${promptText}`,
    });
  } else {
    content.unshift({ type: 'text', text: promptText });
  }

  return content;
}

function computeDelta(previous: string, next: string): string {
  if (!next) return '';
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}

function extractMcpResult(item: McpToolCallItem): string {
  if (!item.result) return '';
  const fromContent = item.result.content
    .map((block) => {
      if (
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        return block.text;
      }
      return JSON.stringify(block);
    })
    .join('\n')
    .trim();

  if (fromContent) return fromContent;
  if (item.result.structured_content !== undefined) {
    return JSON.stringify(item.result.structured_content);
  }
  return '';
}

function summarizeFileChanges(item: FileChangeItem): string {
  if (item.changes.length === 0) {
    return item.status === 'failed' ? 'File change failed.' : 'No file changes reported.';
  }

  return item.changes.map((change) => `${change.kind}: ${change.path}`).join('\n');
}

function mapTodoList(item: TodoListItem, sessionId: string): string {
  return JSON.stringify({
    session_id: sessionId,
    todos: item.items.map((todo, index) => ({
      id: String(index),
      content: todo.text,
      status: todo.completed ? 'completed' : 'pending',
      activeForm: todo.text,
    })),
  });
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}

function shouldRetryWithoutResume(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  const text = message.toLowerCase();
  return text.includes('recorded with model') && text.includes('resuming with');
}

export class CodexEngine implements AgentEngine {
  readonly type = 'codex' as const;
  readonly capabilities = CODEX_CAPABILITIES;

  stream(options: EngineStreamOptions): ReadableStream<string> {
    if (options.workspaceTransport === 'ssh_direct' && options.remoteConnectionId && options.remotePath) {
      return streamRemoteCodex(options);
    }

    const { engineSessionId, sdkSessionId, abortController } = options;
    const resolvedThreadId = engineSessionId ?? sdkSessionId ?? null;
    const codex = new Codex(toCodexOptions(options.provider));
    const threadOptions = toThreadOptions(options);
    let thread = resolvedThreadId
      ? codex.resumeThread(resolvedThreadId, threadOptions)
      : codex.startThread(threadOptions);
    let input = toCodexInput(options, !resolvedThreadId);

    return new ReadableStream<string>({
      async start(controller) {
        let currentThreadId = resolvedThreadId || '';
        let doneSent = false;
        let resultSent = false;

        const emittedToolUse = new Set<string>();
        const itemTextState = new Map<string, string>();
        const commandOutputState = new Map<string, string>();

        const emit = (event: SSEEvent) => {
          controller.enqueue(formatSSE(event));
        };

        const emitDone = () => {
          if (doneSent) return;
          doneSent = true;
          emit({ type: 'done', data: '' });
        };

        const emitToolUse = (id: string, name: string, inputData: unknown) => {
          if (emittedToolUse.has(id)) return;
          emittedToolUse.add(id);
          emit({
            type: 'tool_use',
            data: JSON.stringify({
              id,
              name,
              input: inputData,
            }),
          });
        };

        const emitToolResult = (toolUseId: string, content: string, isError: boolean) => {
          emit({
            type: 'tool_result',
            data: JSON.stringify({
              tool_use_id: toolUseId,
              content,
              is_error: isError,
            }),
          });
        };

        const handleThreadItem = (phase: 'started' | 'updated' | 'completed', item: ThreadItem) => {
          switch (item.type) {
            case 'agent_message': {
              const messageItem = item as AgentMessageItem;
              const previous = itemTextState.get(messageItem.id) || '';
              const delta = computeDelta(previous, messageItem.text || '');
              itemTextState.set(messageItem.id, messageItem.text || '');
              if (delta) {
                emit({ type: 'text', data: delta });
              }
              break;
            }

            case 'command_execution': {
              const commandItem = item as CommandExecutionItem;
              emitToolUse(commandItem.id, 'command_execution', { command: commandItem.command });

              const previousOutput = commandOutputState.get(commandItem.id) || '';
              const currentOutput = commandItem.aggregated_output || '';
              const delta = computeDelta(previousOutput, currentOutput);
              commandOutputState.set(commandItem.id, currentOutput);

              if (delta) {
                emit({ type: 'tool_output', data: delta });
              }

              if (phase === 'completed') {
                const fallback = commandItem.exit_code === undefined
                  ? 'Command finished.'
                  : `Command exited with code ${commandItem.exit_code}.`;
                emitToolResult(
                  commandItem.id,
                  currentOutput || fallback,
                  commandItem.status === 'failed',
                );
              }
              break;
            }

            case 'file_change': {
              const fileChangeItem = item as FileChangeItem;
              emitToolUse(fileChangeItem.id, 'file_change', {
                changes: fileChangeItem.changes,
              });
              if (phase === 'completed') {
                emitToolResult(
                  fileChangeItem.id,
                  summarizeFileChanges(fileChangeItem),
                  fileChangeItem.status === 'failed',
                );
              }
              break;
            }

            case 'mcp_tool_call': {
              const mcpItem = item as McpToolCallItem;
              emitToolUse(mcpItem.id, `mcp:${mcpItem.server}/${mcpItem.tool}`, mcpItem.arguments);
              if (phase === 'completed') {
                const isError = mcpItem.status === 'failed' || !!mcpItem.error;
                const content = isError
                  ? (mcpItem.error?.message || 'MCP tool call failed.')
                  : (extractMcpResult(mcpItem) || 'MCP tool call completed.');
                emitToolResult(mcpItem.id, content, isError);
              }
              break;
            }

            case 'web_search': {
              const searchItem = item as WebSearchItem;
              emitToolUse(searchItem.id, 'web_search', { query: searchItem.query });
              if (phase === 'completed') {
                emitToolResult(searchItem.id, `Web search completed: ${searchItem.query}`, false);
              }
              break;
            }

            case 'todo_list': {
              const todoListItem = item as TodoListItem;
              const sessionId = currentThreadId || options.sessionId;
              emit({
                type: 'task_update',
                data: mapTodoList(todoListItem, sessionId),
              });
              break;
            }

            case 'reasoning':
              // Codex reasoning is currently not rendered as a dedicated frontend block.
              break;

            case 'error': {
              const errorItem = item as ErrorItem;
              emit({ type: 'error', data: errorItem.message });
              break;
            }
          }
        };

        try {
          let allowResumeFallback = !!resolvedThreadId;
          while (true) {
            try {
              if (currentThreadId) {
                emit({
                  type: 'status',
                  data: JSON.stringify({
                    session_id: currentThreadId,
                    model: options.model || '',
                  }),
                });
              }

              const { events } = await thread.runStreamed(input, {
                signal: abortController?.signal,
              });

              for await (const event of events) {
                switch (event.type) {
                  case 'thread.started':
                    currentThreadId = event.thread_id;
                    emit({
                      type: 'status',
                      data: JSON.stringify({
                        session_id: currentThreadId,
                        model: options.model || '',
                      }),
                    });
                    break;

                  case 'turn.started':
                    emit({
                      type: 'status',
                      data: JSON.stringify({
                        notification: true,
                        title: 'Codex',
                        message: 'Turn started.',
                      }),
                    });
                    break;

                  case 'item.started':
                    handleThreadItem('started', event.item);
                    break;

                  case 'item.updated':
                    handleThreadItem('updated', event.item);
                    break;

                  case 'item.completed':
                    handleThreadItem('completed', event.item);
                    break;

                  case 'turn.completed': {
                    resultSent = true;
                    emit({
                      type: 'result',
                      data: JSON.stringify({
                        subtype: 'success',
                        is_error: false,
                        num_turns: 1,
                        usage: toTokenUsage(event.usage),
                        session_id: currentThreadId || resolvedThreadId || '',
                      }),
                    });
                    break;
                  }

                  case 'turn.failed': {
                    resultSent = true;
                    emit({
                      type: 'result',
                      data: JSON.stringify({
                        subtype: 'error',
                        is_error: true,
                        num_turns: 1,
                        usage: null,
                        session_id: currentThreadId || resolvedThreadId || '',
                      }),
                    });
                    emit({ type: 'error', data: event.error.message });
                    break;
                  }

                  case 'error':
                    emit({ type: 'error', data: event.message });
                    break;
                }
              }

              if (!resultSent) {
                emit({
                  type: 'result',
                  data: JSON.stringify({
                    subtype: 'success',
                    is_error: false,
                    num_turns: 1,
                    usage: null,
                    session_id: currentThreadId || resolvedThreadId || '',
                  }),
                });
              }
              break;
            } catch (error) {
              if (
                !isAbortError(error)
                && allowResumeFallback
                && shouldRetryWithoutResume(error)
              ) {
                allowResumeFallback = false;
                currentThreadId = '';
                emittedToolUse.clear();
                itemTextState.clear();
                commandOutputState.clear();
                emit({
                  type: 'status',
                  data: JSON.stringify({
                    notification: true,
                    title: 'Session fallback',
                    message: 'Previous session could not be resumed. Starting fresh conversation.',
                  }),
                });
                thread = codex.startThread(threadOptions);
                input = toCodexInput(options, true);
                continue;
              }
              throw error;
            }
          }
        } catch (error) {
          if (!isAbortError(error)) {
            emit({
              type: 'error',
              data: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          emitDone();
          controller.close();
        }
      },

      cancel() {
        abortController?.abort();
      },
    });
  }
}
