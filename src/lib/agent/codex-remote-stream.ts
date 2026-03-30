import { spawn } from 'child_process';
import readline from 'readline';
import type {
  AgentMessageItem,
  CommandExecutionItem,
  ErrorItem,
  FileChangeItem,
  McpToolCallItem,
  TodoListItem,
  Usage,
  WebSearchItem,
  ThreadEvent,
  ThreadItem,
} from '@openai/codex-sdk';
import type { ApiProvider, SSEEvent, TokenUsage } from '@/types';
import { getRemoteConnection } from '@/lib/remote-connections';
import {
  buildSshProcessArgs,
  quoteShellArg,
  resolveRemoteAbsolutePath,
  shellJoin,
} from '@/lib/remote-ssh';
import { prepareRemoteAttachments } from '@/lib/agent/attachment-paths';
import type { EngineStreamOptions } from '@/lib/agent/types';

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

function buildCodexPrompt(options: EngineStreamOptions, useHistory: boolean, fileReferences: string[]): string {
  const lines: string[] = [];

  if (fileReferences.length > 0) {
    lines.push(...fileReferences);
    lines.push('');
  }

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
  return error instanceof Error && error.name === 'AbortError';
}

function shouldRetryWithoutResume(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  const text = message.toLowerCase();
  return text.includes('recorded with model') && text.includes('resuming with');
}

function collectRemoteEnv(provider?: ApiProvider): Record<string, string> {
  const env: Record<string, string> = {};
  if (provider?.api_key) {
    env.CODEX_API_KEY = provider.api_key;
  }
  if (provider?.base_url) {
    env.OPENAI_BASE_URL = provider.base_url;
  }
  if (provider?.extra_env) {
    try {
      const extra = JSON.parse(provider.extra_env) as Record<string, unknown>;
      for (const [key, value] of Object.entries(extra)) {
        if (typeof value === 'string') {
          env[key] = value;
        }
      }
    } catch {
      // ignore malformed extra_env
    }
  }
  return env;
}

function buildRemoteShellScript(
  remoteCwd: string,
  env: Record<string, string>,
  commandArgs: string[],
): string {
  const exports = Object.entries(env)
    .filter(([, value]) => value)
    .map(([key, value]) => `export ${key}=${quoteShellArg(value)};`)
    .join(' ');
  const command = shellJoin(commandArgs);
  return `cd ${quoteShellArg(remoteCwd)} && ${exports} ${command}`.trim();
}

function buildCodexExecArgs(options: EngineStreamOptions, threadId: string | null, imagePaths: string[]): string[] {
  const args = ['codex', 'exec', '--experimental-json', '--skip-git-repo-check'];
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.modelReasoningEffort) {
    args.push('--config', `model_reasoning_effort=${options.modelReasoningEffort}`);
  }
  for (const imagePath of imagePaths) {
    args.push('--image', imagePath);
  }
  if (threadId) {
    args.push('resume', threadId, '-');
  } else {
    args.push('-');
  }
  return args;
}

export function streamRemoteCodex(options: EngineStreamOptions): ReadableStream<string> {
  const { engineSessionId, sdkSessionId, abortController } = options;
  const resolvedThreadId = engineSessionId ?? sdkSessionId ?? null;

  return new ReadableStream<string>({
    async start(controller) {
      const emit = (event: SSEEvent) => {
        controller.enqueue(formatSSE(event));
      };
      const emitDone = () => emit({ type: 'done', data: '' });

      const connectionId = (options.remoteConnectionId || '').trim();
      const remotePath = (options.remotePath || '').trim();
      if (!connectionId || !remotePath) {
        emit({ type: 'error', data: 'Remote Codex requires a remote connection and remote path.' });
        emitDone();
        controller.close();
        return;
      }

      const connection = getRemoteConnection(connectionId);
      if (!connection) {
        emit({ type: 'error', data: 'Remote connection not found.' });
        emitDone();
        controller.close();
        return;
      }

      const localWorkDir = options.workingDirectory || process.cwd();
      const remoteCwd = resolveRemoteAbsolutePath(connection, remotePath);
      const remoteAttachments = await prepareRemoteAttachments(options.files || [], localWorkDir, connection, remoteCwd);
      const remoteImages = remoteAttachments.filter((entry) => entry.file.type.startsWith('image/'));
      const remoteFiles = remoteAttachments.filter((entry) => !entry.file.type.startsWith('image/'));
      let currentThreadId = resolvedThreadId || '';
      let resultSent = false;
      const emittedToolUse = new Set<string>();
      const itemTextState = new Map<string, string>();
      const commandOutputState = new Map<string, string>();

      const emitToolUse = (id: string, name: string, inputData: unknown) => {
        if (emittedToolUse.has(id)) return;
        emittedToolUse.add(id);
        emit({
          type: 'tool_use',
          data: JSON.stringify({ id, name, input: inputData }),
        });
      };

      const emitToolResult = (toolUseId: string, content: string, isError: boolean) => {
        emit({
          type: 'tool_result',
          data: JSON.stringify({ tool_use_id: toolUseId, content, is_error: isError }),
        });
      };

      const handleThreadItem = (phase: 'started' | 'updated' | 'completed', item: ThreadItem) => {
        switch (item.type) {
          case 'agent_message': {
            const messageItem = item as AgentMessageItem;
            const previous = itemTextState.get(messageItem.id) || '';
            const delta = computeDelta(previous, messageItem.text || '');
            itemTextState.set(messageItem.id, messageItem.text || '');
            if (delta) emit({ type: 'text', data: delta });
            break;
          }
          case 'command_execution': {
            const commandItem = item as CommandExecutionItem;
            emitToolUse(commandItem.id, 'command_execution', { command: commandItem.command });
            const previousOutput = commandOutputState.get(commandItem.id) || '';
            const currentOutput = commandItem.aggregated_output || '';
            const delta = computeDelta(previousOutput, currentOutput);
            commandOutputState.set(commandItem.id, currentOutput);
            if (delta) emit({ type: 'tool_output', data: delta });
            if (phase === 'completed') {
              const fallback = commandItem.exit_code === undefined ? 'Command finished.' : `Command exited with code ${commandItem.exit_code}.`;
              emitToolResult(commandItem.id, currentOutput || fallback, commandItem.status === 'failed');
            }
            break;
          }
          case 'file_change': {
            const fileChangeItem = item as FileChangeItem;
            emitToolUse(fileChangeItem.id, 'file_change', { changes: fileChangeItem.changes });
            if (phase === 'completed') {
              emitToolResult(fileChangeItem.id, summarizeFileChanges(fileChangeItem), fileChangeItem.status === 'failed');
            }
            break;
          }
          case 'mcp_tool_call': {
            const mcpItem = item as McpToolCallItem;
            emitToolUse(mcpItem.id, `mcp:${mcpItem.server}/${mcpItem.tool}`, mcpItem.arguments);
            if (phase === 'completed') {
              const isError = mcpItem.status === 'failed' || !!mcpItem.error;
              const content = isError ? (mcpItem.error?.message || 'MCP tool call failed.') : (extractMcpResult(mcpItem) || 'MCP tool call completed.');
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
            emit({ type: 'task_update', data: mapTodoList(todoListItem, currentThreadId || options.sessionId) });
            break;
          }
          case 'reasoning':
            break;
          case 'error': {
            const errorItem = item as ErrorItem;
            emit({ type: 'error', data: errorItem.message });
            break;
          }
        }
      };

      const runOnce = async (threadId: string | null, useHistory: boolean) => {
        const fileReferences = remoteFiles.map((entry) => `[User attached file: ${entry.remotePath} (${entry.file.name})]`);
        const prompt = buildCodexPrompt(options, useHistory, fileReferences);
        const env = collectRemoteEnv(options.provider);
        const shellScript = buildRemoteShellScript(
          remoteCwd,
          env,
          buildCodexExecArgs(options, threadId, remoteImages.map((entry) => entry.remotePath)),
        );
        const child = spawn('ssh', buildSshProcessArgs(connection, ['sh', '-lc', shellScript], { batchMode: false }), {
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: abortController?.signal,
        });

        if (!child.stdin || !child.stdout) {
          child.kill('SIGTERM');
          throw new Error('Remote Codex process did not expose stdin/stdout.');
        }

        const stderrChunks: Buffer[] = [];
        if (child.stderr) {
          child.stderr.on('data', (chunk: Buffer | string) => {
            stderrChunks.push(Buffer.from(typeof chunk === 'string' ? chunk : chunk));
          });
        }

        child.stdin.write(prompt);
        child.stdin.end();

        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as ThreadEvent;
            switch (event.type) {
              case 'thread.started':
                currentThreadId = event.thread_id;
                emit({ type: 'status', data: JSON.stringify({ session_id: currentThreadId, model: options.model || '', runtime: 'remote' }) });
                break;
              case 'turn.started':
                emit({ type: 'status', data: JSON.stringify({ notification: true, title: 'Codex', message: 'Remote turn started.', runtime: 'remote' }) });
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
              case 'turn.completed':
                resultSent = true;
                emit({ type: 'result', data: JSON.stringify({ subtype: 'success', is_error: false, num_turns: 1, usage: toTokenUsage(event.usage), session_id: currentThreadId || threadId || '' }) });
                break;
              case 'turn.failed':
                resultSent = true;
                emit({ type: 'result', data: JSON.stringify({ subtype: 'error', is_error: true, num_turns: 1, usage: null, session_id: currentThreadId || threadId || '' }) });
                emit({ type: 'error', data: event.error.message });
                break;
              case 'error':
                emit({ type: 'error', data: event.message });
                break;
            }
          }

          const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            child.once('exit', (code, signal) => resolve({ code, signal }));
          });
          if (exitResult.code !== 0 || exitResult.signal) {
            const detail = exitResult.signal ? `signal ${exitResult.signal}` : `code ${exitResult.code ?? 1}`;
            const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
            throw new Error(`Remote Codex exited with ${detail}${stderr ? `: ${stderr}` : ''}`);
          }
        } finally {
          rl.close();
          child.removeAllListeners();
          if (!child.killed) {
            try {
              child.kill('SIGTERM');
            } catch {
              // ignore kill failures
            }
          }
        }
      };

      try {
        let allowResumeFallback = !!resolvedThreadId;
        while (true) {
          try {
            if (currentThreadId) {
              emit({ type: 'status', data: JSON.stringify({ session_id: currentThreadId, model: options.model || '', runtime: 'remote' }) });
            }
            await runOnce(currentThreadId || resolvedThreadId, !currentThreadId && !resolvedThreadId);
            if (!resultSent) {
              emit({ type: 'result', data: JSON.stringify({ subtype: 'success', is_error: false, num_turns: 1, usage: null, session_id: currentThreadId || resolvedThreadId || '' }) });
            }
            break;
          } catch (error) {
            if (!isAbortError(error) && allowResumeFallback && shouldRetryWithoutResume(error)) {
              allowResumeFallback = false;
              currentThreadId = '';
              emittedToolUse.clear();
              itemTextState.clear();
              commandOutputState.clear();
              emit({ type: 'status', data: JSON.stringify({ notification: true, title: 'Session fallback', message: 'Previous remote session could not be resumed. Starting fresh conversation.', runtime: 'remote' }) });
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        if (!isAbortError(error)) {
          emit({ type: 'error', data: error instanceof Error ? error.message : String(error) });
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
