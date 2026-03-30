import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
  Options,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  McpServerConfig,
  NotificationHookInput,
  PostToolUseHookInput,
  PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeStreamOptions, SSEEvent, TokenUsage, MCPServerConfig, PermissionRequestEvent, FileAttachment, ApiProvider } from '@/types';
import { isImageFile } from '@/types';
import { registerPendingPermission } from './permission-registry';
import { getConversation, registerConversation, unregisterConversation } from './conversation-registry';
import { getSetting, getActiveProvider, updateSdkSessionId, createPermissionRequest } from './db';
import { findClaudeBinary, findGitBash, getExpandedPath } from './platform';
import { notifyPermissionRequest, notifyGeneric } from './telegram-bot';
import type { ClaudeNativeConversationHandle } from '@/lib/agent/claude-native-controller';
import os from 'os';
import fs from 'fs';
import path from 'path';

/**
 * Sanitize a string for use as an environment variable value.
 * Removes null bytes and control characters that cause spawn EINVAL.
 */
function sanitizeEnvValue(value: string): string {
   
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Sanitize all values in an env record so child_process.spawn won't
 * throw EINVAL due to invalid characters or non-string values.
 * On Windows, spawn is strict: every env value MUST be a string.
 * Spreading process.env can include undefined values which cause EINVAL.
 */
function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      clean[key] = sanitizeEnvValue(value);
    }
  }
  return clean;
}

/**
 * On Windows, npm installs CLI tools as .cmd wrappers that can't be
 * spawned without shell:true. Parse the wrapper to extract the real
 * .js script path so we can pass it to the SDK directly.
 */
function resolveScriptFromCmd(cmdPath: string): string | undefined {
  try {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const cmdDir = path.dirname(cmdPath);

    // npm .cmd wrappers typically contain a line like:
    //   "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*
    // Match paths containing claude-code or claude-agent and ending in .js
    const patterns = [
      // Quoted: "%~dp0\...\cli.js"
      /"%~dp0\\([^"]*claude[^"]*\.js)"/i,
      // Unquoted: %~dp0\...\cli.js
      /%~dp0\\(\S*claude\S*\.js)/i,
      // Quoted with %dp0%: "%dp0%\...\cli.js"
      /"%dp0%\\([^"]*claude[^"]*\.js)"/i,
    ];

    for (const re of patterns) {
      const m = content.match(re);
      if (m) {
        const resolved = path.normalize(path.join(cmdDir, m[1]));
        if (fs.existsSync(resolved)) return resolved;
      }
    }
  } catch {
    // ignore read errors
  }
  return undefined;
}

let cachedClaudePath: string | null | undefined;

function findClaudePath(): string | undefined {
  if (cachedClaudePath !== undefined) return cachedClaudePath || undefined;
  const found = findClaudeBinary();
  cachedClaudePath = found ?? null;
  return found;
}

/**
 * Convert our MCPServerConfig to the SDK's McpServerConfig format.
 * Supports stdio, sse, and http transport types.
 */
function toSdkMcpConfig(
  servers: Record<string, MCPServerConfig>
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    const transport = config.type || 'stdio';

    switch (transport) {
      case 'sse': {
        if (!config.url) {
          console.warn(`[mcp] SSE server "${name}" is missing url, skipping`);
          continue;
        }
        const sseConfig: McpSSEServerConfig = {
          type: 'sse',
          url: config.url,
        };
        if (config.headers && Object.keys(config.headers).length > 0) {
          sseConfig.headers = config.headers;
        }
        result[name] = sseConfig;
        break;
      }

      case 'http': {
        if (!config.url) {
          console.warn(`[mcp] HTTP server "${name}" is missing url, skipping`);
          continue;
        }
        const httpConfig: McpHttpServerConfig = {
          type: 'http',
          url: config.url,
        };
        if (config.headers && Object.keys(config.headers).length > 0) {
          httpConfig.headers = config.headers;
        }
        result[name] = httpConfig;
        break;
      }

      case 'stdio':
      default: {
        if (!config.command) {
          console.warn(`[mcp] stdio server "${name}" is missing command, skipping`);
          continue;
        }
        const stdioConfig: McpStdioServerConfig = {
          command: config.command,
          args: config.args,
          env: config.env,
        };
        result[name] = stdioConfig;
        break;
      }
    }
  }
  return result;
}

/**
 * Format an SSE line from an event object
 */
function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Extract token usage from an SDK result message
 */
function extractTokenUsage(msg: SDKResultMessage): TokenUsage | null {
  if (!msg.usage) return null;
  return {
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    cost_usd: 'total_cost_usd' in msg ? msg.total_cost_usd : undefined,
  };
}

/**
 * Stream Claude responses using the Agent SDK.
 * Returns a ReadableStream of SSE-formatted strings.
 */
/**
 * Get file paths for non-image attachments. If the file already has a
 * persisted filePath (written by the uploads route), reuse it. Otherwise
 * fall back to writing the file to .codepilot-uploads/.
 */
function getUploadedFilePaths(files: FileAttachment[], workDir: string): string[] {
  const paths: string[] = [];
  let uploadDir: string | undefined;
  for (const file of files) {
    if (file.filePath) {
      paths.push(file.filePath);
    } else {
      // Fallback: write file to disk (should not happen in normal flow)
      if (!uploadDir) {
        uploadDir = path.join(workDir, '.codepilot-uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
      }
      const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
      const buffer = Buffer.from(file.data, 'base64');
      fs.writeFileSync(filePath, buffer);
      paths.push(filePath);
    }
  }
  return paths;
}

/**
 * Build a context-enriched prompt by prepending conversation history.
 * Used when SDK session resume is unavailable or fails.
 */
function buildPromptWithHistory(
  prompt: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (!history || history.length === 0) return prompt;

  const lines: string[] = ['<conversation_history>'];
  for (const msg of history) {
    // For assistant messages with tool blocks (JSON arrays), summarize
    let content = msg.content;
    if (msg.role === 'assistant' && content.startsWith('[')) {
      try {
        const blocks = JSON.parse(content);
        const parts: string[] = [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) parts.push(b.text);
          else if (b.type === 'tool_use') parts.push(`[Used tool: ${b.name}]`);
          else if (b.type === 'tool_result') {
            const resultStr = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            // Truncate long tool results
            parts.push(`[Tool result: ${resultStr.slice(0, 500)}${resultStr.length > 500 ? '...' : ''}]`);
          }
        }
        content = parts.join('\n');
      } catch {
        // Not JSON, use as-is
      }
    }
    lines.push(`${msg.role === 'user' ? 'Human' : 'Assistant'}: ${content}`);
  }
  lines.push('</conversation_history>');
  lines.push('');
  lines.push(prompt);
  return lines.join('\n');
}

type ClaudeQuery = ReturnType<typeof query>;

interface TurnStreamState {
  controller: ReadableStreamDefaultController<string>;
  abortController?: AbortController;
  onRuntimeStatusChange?: (status: string) => void;
  toolTimeoutSeconds: number;
  finished: boolean;
  abortRequested: boolean;
  abortTimeout: NodeJS.Timeout | null;
  removeAbortListener?: () => void;
}

interface ClaudeRuntimeSessionState {
  sessionId: string;
  runtimeKey: string;
  workingDirectory: string;
  activeProvider?: ApiProvider;
  inputQueue: AsyncUserMessageQueue;
  conversation: ClaudeQuery;
  activeTurn: TurnStreamState | null;
  closed: boolean;
  includeHistoryOnFirstTurn: boolean;
  turnsStarted: number;
  skipPermissions: boolean;
  lastSdkSessionId: string;
  initialSdkSessionId: string;
  currentModel?: string;
  currentPermissionMode: PermissionMode;
  pendingEvents: SSEEvent[];
  telegramOpts: {
    sessionId: string;
    sessionTitle?: string;
    workingDirectory?: string;
  };
}

class AsyncUserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolvers: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  enqueue(message: SDKUserMessage): void {
    if (this.ended) {
      throw new Error('Runtime input queue already closed.');
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.queue.shift();
        if (message) {
          return Promise.resolve({ done: false, value: message });
        }
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

const runtimeMapKey = '__claudeRuntimeSessions__' as const;
const abortDrainTimeoutMs = 5000;

function getRuntimeMap(): Map<string, ClaudeRuntimeSessionState> {
  if (!(globalThis as Record<string, unknown>)[runtimeMapKey]) {
    (globalThis as Record<string, unknown>)[runtimeMapKey] = new Map<string, ClaudeRuntimeSessionState>();
  }
  return (globalThis as Record<string, unknown>)[runtimeMapKey] as Map<string, ClaudeRuntimeSessionState>;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`);
  return `{${entries.join(',')}}`;
}

function buildProviderSignature(provider?: ApiProvider): string {
  if (!provider) return 'env';
  return stableStringify({
    id: provider.id,
    base_url: provider.base_url || '',
    api_key: provider.api_key || '',
    extra_env: provider.extra_env || '',
  });
}

function buildRuntimeKey(options: ClaudeStreamOptions, activeProvider?: ApiProvider): string {
  return stableStringify({
    cwd: options.workingDirectory || os.homedir(),
    systemPrompt: options.systemPrompt || '',
    mcpServers: options.mcpServers || {},
    provider: buildProviderSignature(activeProvider),
  });
}

function enqueueSSE(controller: ReadableStreamDefaultController<string>, event: SSEEvent): void {
  controller.enqueue(formatSSE(event));
}

function emitTurnEvent(turn: TurnStreamState | null, event: SSEEvent): void {
  if (!turn || turn.finished) return;
  try {
    enqueueSSE(turn.controller, event);
  } catch {
    // Stream already closed/cancelled
  }
}

function finishTurn(runtime: ClaudeRuntimeSessionState, turn: TurnStreamState, options?: { sendDone?: boolean }): void {
  if (turn.finished) return;
  turn.finished = true;
  turn.removeAbortListener?.();
  turn.removeAbortListener = undefined;
  if (turn.abortTimeout) {
    clearTimeout(turn.abortTimeout);
    turn.abortTimeout = null;
  }
  if (options?.sendDone !== false) {
    emitTurnEvent(turn, { type: 'done', data: '' });
  }
  try {
    turn.controller.close();
  } catch {
    // Stream already closed
  }
  if (runtime.activeTurn === turn) {
    runtime.activeTurn = null;
  }
}

function teardownRuntime(runtime: ClaudeRuntimeSessionState, reason?: string): void {
  if (runtime.closed) return;
  runtime.closed = true;

  const turn = runtime.activeTurn;
  if (turn && !turn.finished && reason) {
    emitTurnEvent(turn, { type: 'error', data: reason });
  }
  if (turn && !turn.finished) {
    finishTurn(runtime, turn);
  }

  runtime.inputQueue.close();
  try {
    runtime.conversation.close();
  } catch {
    // Best effort
  }

  unregisterConversation(runtime.sessionId);
  const runtimeMap = getRuntimeMap();
  if (runtimeMap.get(runtime.sessionId) === runtime) {
    runtimeMap.delete(runtime.sessionId);
  }
}

function buildErrorMessage(error: unknown, activeProvider?: ApiProvider): string {
  const rawMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('[claude-client] Stream error:', {
    message: rawMessage,
    stack: error instanceof Error ? error.stack : undefined,
    cause: error instanceof Error ? (error as { cause?: unknown }).cause : undefined,
    stderr: error instanceof Error ? (error as { stderr?: string }).stderr : undefined,
    code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
  });

  const stderr = error instanceof Error ? (error as { stderr?: string }).stderr : undefined;
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const extraDetail = stderr || (cause instanceof Error ? cause.message : cause ? String(cause) : '');

  let errorMessage = rawMessage;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || rawMessage.includes('ENOENT') || rawMessage.includes('spawn')) {
      errorMessage = `Claude Code CLI not found. Please ensure Claude Code is installed and available in your PATH.\n\nOriginal error: ${rawMessage}`;
    } else if (rawMessage.includes('exited with code 1') || rawMessage.includes('exit code 1')) {
      const providerHint = activeProvider?.name ? ` (Provider: ${activeProvider.name})` : '';
      const detailHint = extraDetail ? `\n\nDetails: ${extraDetail}` : '';
      errorMessage = `Claude Code process exited with an error${providerHint}. This is often caused by:\n• Invalid or missing API Key\n• Incorrect Base URL configuration\n• Network connectivity issues${detailHint}\n\nOriginal error: ${rawMessage}`;
    } else if (rawMessage.includes('exited with code')) {
      const providerHint = activeProvider?.name ? ` (Provider: ${activeProvider.name})` : '';
      errorMessage = `Claude Code process crashed unexpectedly${providerHint}.\n\nOriginal error: ${rawMessage}`;
    } else if (code === 'ECONNREFUSED' || rawMessage.includes('ECONNREFUSED') || rawMessage.includes('fetch failed')) {
      const baseUrl = activeProvider?.base_url || 'default';
      errorMessage = `Cannot connect to API endpoint (${baseUrl}). Please check your network connection and Base URL configuration.\n\nOriginal error: ${rawMessage}`;
    } else if (rawMessage.includes('401') || rawMessage.includes('Unauthorized') || rawMessage.includes('authentication')) {
      const providerHint = activeProvider?.name ? ` for provider "${activeProvider.name}"` : '';
      errorMessage = `Authentication failed${providerHint}. Please verify your API Key is correct and has not expired.\n\nOriginal error: ${rawMessage}`;
    } else if (rawMessage.includes('403') || rawMessage.includes('Forbidden')) {
      errorMessage = `Access denied. Your API Key may not have permission for this operation.\n\nOriginal error: ${rawMessage}`;
    } else if (rawMessage.includes('429') || rawMessage.includes('rate limit') || rawMessage.includes('Rate limit')) {
      errorMessage = `Rate limit exceeded. Please wait a moment before retrying.\n\nOriginal error: ${rawMessage}`;
    }
  }
  return errorMessage;
}

function buildSdkEnv(activeProvider?: ApiProvider): Record<string, string> {
  const sdkEnv: Record<string, string> = { ...process.env as Record<string, string> };

  if (!sdkEnv.HOME) sdkEnv.HOME = os.homedir();
  if (!sdkEnv.USERPROFILE) sdkEnv.USERPROFILE = os.homedir();
  sdkEnv.PATH = getExpandedPath();
  delete sdkEnv.CLAUDECODE;

  if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitBashPath = findGitBash();
    if (gitBashPath) {
      sdkEnv.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
    }
  }

  if (activeProvider && activeProvider.api_key) {
    for (const key of Object.keys(sdkEnv)) {
      if (key.startsWith('ANTHROPIC_')) {
        delete sdkEnv[key];
      }
    }

    sdkEnv.ANTHROPIC_AUTH_TOKEN = activeProvider.api_key;
    sdkEnv.ANTHROPIC_API_KEY = activeProvider.api_key;
    if (activeProvider.base_url) {
      sdkEnv.ANTHROPIC_BASE_URL = activeProvider.base_url;
    }

    try {
      const extraEnv = JSON.parse(activeProvider.extra_env || '{}');
      for (const [key, value] of Object.entries(extraEnv)) {
        if (typeof value === 'string') {
          if (value === '') {
            delete sdkEnv[key];
          } else {
            sdkEnv[key] = value;
          }
        }
      }
    } catch {
      // ignore malformed extra_env
    }
  } else {
    const appToken = getSetting('anthropic_auth_token');
    const appBaseUrl = getSetting('anthropic_base_url');
    if (appToken) sdkEnv.ANTHROPIC_AUTH_TOKEN = appToken;
    if (appBaseUrl) sdkEnv.ANTHROPIC_BASE_URL = appBaseUrl;
    if (!appToken && !sdkEnv.ANTHROPIC_API_KEY && !sdkEnv.ANTHROPIC_AUTH_TOKEN) {
      console.warn('[claude-client] No API key found: no active provider, no legacy settings, and no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in environment');
    }
  }

  return sanitizeEnv(sdkEnv);
}

function buildTurnUserMessage(params: {
  prompt: string;
  files?: FileAttachment[];
  workingDirectory: string;
  imageAgentMode?: boolean;
  includeHistory: boolean;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  sdkSessionId: string;
}): SDKUserMessage {
  const {
    prompt,
    files,
    workingDirectory,
    imageAgentMode,
    includeHistory,
    conversationHistory,
    sdkSessionId,
  } = params;

  const basePrompt = includeHistory
    ? buildPromptWithHistory(prompt, conversationHistory)
    : prompt;

  if (!files || files.length === 0) {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: basePrompt,
      },
      parent_tool_use_id: null,
      session_id: sdkSessionId,
    };
  }

  const imageFiles = files.filter((f) => isImageFile(f.type));
  const nonImageFiles = files.filter((f) => !isImageFile(f.type));

  let textPrompt = basePrompt;
  if (nonImageFiles.length > 0) {
    const savedPaths = getUploadedFilePaths(nonImageFiles, workingDirectory);
    const fileReferences = savedPaths
      .map((savedPath, i) => `[User attached file: ${savedPath} (${nonImageFiles[i].name})]`)
      .join('\n');
    textPrompt = `${fileReferences}\n\nPlease read the attached file(s) above using your Read tool, then respond to the user's message:\n\n${basePrompt}`;
  }

  if (imageFiles.length === 0) {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: textPrompt,
      },
      parent_tool_use_id: null,
      session_id: sdkSessionId,
    };
  }

  const textWithImageRefs = imageAgentMode
    ? textPrompt
    : (() => {
        const imagePaths = getUploadedFilePaths(imageFiles, workingDirectory);
        const imageReferences = imagePaths
          .map((savedPath, i) => `[User attached image: ${savedPath} (${imageFiles[i].name})]`)
          .join('\n');
        return `${imageReferences}\n\n${textPrompt}`;
      })();

  const contentBlocks: Array<
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'text'; text: string }
  > = [];

  for (const img of imageFiles) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.type || 'image/png',
        data: img.data,
      },
    });
  }
  contentBlocks.push({ type: 'text', text: textWithImageRefs });

  return {
    type: 'user',
    message: {
      role: 'user',
      content: contentBlocks,
    },
    parent_tool_use_id: null,
    session_id: sdkSessionId,
  };
}

function createConversationHandle(runtime: ClaudeRuntimeSessionState): ClaudeNativeConversationHandle {
  return {
    setPermissionMode: async (mode) => {
      await runtime.conversation.setPermissionMode(mode as PermissionMode);
      runtime.currentPermissionMode = mode;
    },
    setModel: async (model) => {
      await runtime.conversation.setModel(model);
      runtime.currentModel = model;
    },
    supportedCommands: async () => runtime.conversation.supportedCommands(),
    supportedModels: async () => runtime.conversation.supportedModels(),
    mcpServerStatus: async () => runtime.conversation.mcpServerStatus(),
    rewindFiles: async (userMessageId, rewindOptions) => runtime.conversation.rewindFiles(userMessageId, rewindOptions),
    initializationResult: async () => runtime.conversation.initializationResult(),
    accountInfo: async () => runtime.conversation.accountInfo(),
  };
}

function emitRuntimeEvent(runtime: ClaudeRuntimeSessionState, event: SSEEvent): void {
  emitTurnEvent(runtime.activeTurn, event);
}

function requestTurnAbort(runtime: ClaudeRuntimeSessionState, turn: TurnStreamState): void {
  if (turn.finished || turn.abortRequested) return;
  turn.abortRequested = true;

  void runtime.conversation.interrupt().catch(() => {
    // Best effort: runtime may already be closing.
  });

  turn.abortTimeout = setTimeout(() => {
    if (runtime.activeTurn === turn && !turn.finished) {
      teardownRuntime(runtime, 'Runtime interrupt timeout; runtime restarted.');
    }
  }, abortDrainTimeoutMs);
}

function handleRuntimeMessage(runtime: ClaudeRuntimeSessionState, message: SDKMessage): void {
  const turn = runtime.activeTurn;
  const abortRequested = !!turn?.abortRequested;

  switch (message.type) {
    case 'assistant': {
      if (!turn || abortRequested) break;
      const assistantMsg = message as SDKAssistantMessage;
      for (const block of assistantMsg.message.content) {
        if (block.type === 'tool_use') {
          emitRuntimeEvent(runtime, {
            type: 'tool_use',
            data: JSON.stringify({
              id: block.id,
              name: block.name,
              input: block.input,
            }),
          });
        }
      }
      break;
    }

    case 'user': {
      if (!turn || abortRequested) break;
      const userMsg = message as SDKUserMessage;
      const content = userMsg.message.content;
      if (!Array.isArray(content)) break;

      for (const block of content) {
        if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .filter((c: { type: string }) => c.type === 'text')
                  .map((c: { text: string }) => c.text)
                  .join('\n')
              : String(block.content ?? '');

          emitRuntimeEvent(runtime, {
            type: 'tool_result',
            data: JSON.stringify({
              tool_use_id: block.tool_use_id,
              content: resultContent,
              is_error: block.is_error || false,
            }),
          });
        }
      }
      break;
    }

    case 'stream_event': {
      if (!turn || abortRequested) break;
      const streamEvent = message as SDKPartialAssistantMessage;
      const evt = streamEvent.event;
      if (evt.type === 'content_block_delta' && 'delta' in evt) {
        const delta = evt.delta;
        if ('text' in delta && delta.text) {
          emitRuntimeEvent(runtime, { type: 'text', data: delta.text });
        }
      }
      break;
    }

    case 'system': {
      const sysMsg = message as SDKSystemMessage;
      if (!('subtype' in sysMsg)) break;

      if (sysMsg.subtype === 'init') {
        runtime.lastSdkSessionId = sysMsg.session_id || runtime.lastSdkSessionId;
        runtime.currentModel = sysMsg.model || runtime.currentModel;
        if (!abortRequested) {
          emitRuntimeEvent(runtime, {
            type: 'status',
            data: JSON.stringify({
              session_id: sysMsg.session_id,
              model: sysMsg.model,
              tools: sysMsg.tools,
            }),
          });
        }
      } else if (sysMsg.subtype === 'status') {
        const statusMsg = sysMsg as SDKSystemMessage & { permissionMode?: PermissionMode };
        if (statusMsg.permissionMode) {
          runtime.currentPermissionMode = statusMsg.permissionMode;
          if (!abortRequested) {
            emitRuntimeEvent(runtime, {
              type: 'mode_changed',
              data: statusMsg.permissionMode,
            });
          }
        }
      }
      break;
    }

    case 'tool_progress': {
      if (!turn || abortRequested) break;
      const progressMsg = message as SDKToolProgressMessage;
      emitRuntimeEvent(runtime, {
        type: 'tool_output',
        data: JSON.stringify({
          _progress: true,
          tool_use_id: progressMsg.tool_use_id,
          tool_name: progressMsg.tool_name,
          elapsed_time_seconds: progressMsg.elapsed_time_seconds,
        }),
      });

      if (turn.toolTimeoutSeconds > 0 && progressMsg.elapsed_time_seconds >= turn.toolTimeoutSeconds) {
        emitRuntimeEvent(runtime, {
          type: 'tool_timeout',
          data: JSON.stringify({
            tool_name: progressMsg.tool_name,
            elapsed_seconds: Math.round(progressMsg.elapsed_time_seconds),
          }),
        });
        turn.abortController?.abort();
      }
      break;
    }

    case 'result': {
      const resultMsg = message as SDKResultMessage;
      runtime.lastSdkSessionId = resultMsg.session_id || runtime.lastSdkSessionId;
      if (turn) {
        if (!abortRequested) {
          const tokenUsage = extractTokenUsage(resultMsg);
          emitRuntimeEvent(runtime, {
            type: 'result',
            data: JSON.stringify({
              subtype: resultMsg.subtype,
              is_error: resultMsg.is_error,
              num_turns: resultMsg.num_turns,
              duration_ms: resultMsg.duration_ms,
              usage: tokenUsage,
              session_id: resultMsg.session_id,
            }),
          });
        }
        finishTurn(runtime, turn);
      }
      break;
    }

    default: {
      if (!turn || abortRequested) break;
      if ((message as { type: string }).type === 'keep_alive') {
        emitRuntimeEvent(runtime, { type: 'keep_alive', data: '' });
      }
      break;
    }
  }
}

async function runRuntimeReader(runtime: ClaudeRuntimeSessionState): Promise<void> {
  try {
    for await (const message of runtime.conversation) {
      if (runtime.closed) break;
      handleRuntimeMessage(runtime, message);
    }

    if (!runtime.closed) {
      teardownRuntime(runtime, 'Claude runtime exited unexpectedly.');
    }
  } catch (error) {
    if (runtime.closed) return;

    const activeTurn = runtime.activeTurn;
    const abortedByUser = !!activeTurn?.abortRequested
      && error instanceof Error
      && /abort/i.test(error.message);
    const errorMessage = buildErrorMessage(error, runtime.activeProvider);

    if (!abortedByUser && activeTurn && !activeTurn.finished) {
      emitTurnEvent(activeTurn, { type: 'error', data: errorMessage });
    }

    if (runtime.initialSdkSessionId && runtime.sessionId) {
      try {
        updateSdkSessionId(runtime.sessionId, '');
        console.warn('[claude-client] Cleared stale sdk_session_id for session', runtime.sessionId);
      } catch {
        // best effort
      }
    }

    teardownRuntime(runtime);
  }
}

function createRuntimeSession(options: ClaudeStreamOptions, activeProvider?: ApiProvider): ClaudeRuntimeSessionState {
  const workingDirectory = options.workingDirectory || os.homedir();
  const skipPermissions = getSetting('dangerously_skip_permissions') === 'true';
  const initialPermissionMode = skipPermissions
    ? 'bypassPermissions'
    : ((options.permissionMode as PermissionMode) || 'acceptEdits');

  const queryOptions: Options = {
    cwd: workingDirectory,
    includePartialMessages: true,
    enableFileCheckpointing: true,
    permissionMode: initialPermissionMode,
    env: buildSdkEnv(activeProvider),
    settingSources: activeProvider?.api_key
      ? ['project', 'local']
      : ['user', 'project', 'local'],
  };

  if (skipPermissions) {
    queryOptions.allowDangerouslySkipPermissions = true;
  }

  const claudePath = findClaudePath();
  if (claudePath) {
    const ext = path.extname(claudePath).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      const scriptPath = resolveScriptFromCmd(claudePath);
      if (scriptPath) {
        queryOptions.pathToClaudeCodeExecutable = scriptPath;
      } else {
        console.warn('[claude-client] Could not resolve .js path from .cmd wrapper, falling back to SDK resolution:', claudePath);
      }
    } else {
      queryOptions.pathToClaudeCodeExecutable = claudePath;
    }
  }

  if (options.model) {
    queryOptions.model = options.model;
  }

  if (options.systemPrompt) {
    queryOptions.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: options.systemPrompt,
    };
  }

  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    queryOptions.mcpServers = toSdkMcpConfig(options.mcpServers);
  }

  const pendingEvents: SSEEvent[] = [];
  let shouldResume = !!options.sdkSessionId;
  if (shouldResume && options.workingDirectory && !fs.existsSync(options.workingDirectory)) {
    console.warn(`[claude-client] Working directory "${options.workingDirectory}" does not exist, skipping resume`);
    shouldResume = false;
    try { updateSdkSessionId(options.sessionId, ''); } catch { /* best effort */ }
    pendingEvents.push({
      type: 'status',
      data: JSON.stringify({
        notification: true,
        title: 'Session fallback',
        message: 'Original working directory no longer exists. Starting fresh conversation.',
      }),
    });
  }
  if (shouldResume && options.sdkSessionId) {
    queryOptions.resume = options.sdkSessionId;
  }

  const runtime: ClaudeRuntimeSessionState = {
    sessionId: options.sessionId,
    runtimeKey: buildRuntimeKey(options, activeProvider),
    workingDirectory,
    activeProvider,
    inputQueue: new AsyncUserMessageQueue(),
    conversation: null as unknown as ClaudeQuery,
    activeTurn: null,
    closed: false,
    includeHistoryOnFirstTurn: !shouldResume,
    turnsStarted: 0,
    skipPermissions,
    lastSdkSessionId: options.sdkSessionId || '',
    initialSdkSessionId: options.sdkSessionId || '',
    currentModel: options.model,
    currentPermissionMode: initialPermissionMode,
    pendingEvents,
    telegramOpts: {
      sessionId: options.sessionId,
      sessionTitle: undefined,
      workingDirectory: options.workingDirectory,
    },
  };

  queryOptions.canUseTool = async (toolName, input, opts) => {
    const permissionRequestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const permEvent: PermissionRequestEvent = {
      permissionRequestId,
      toolName,
      toolInput: input,
      suggestions: opts.suggestions as PermissionRequestEvent['suggestions'],
      decisionReason: opts.decisionReason,
      blockedPath: opts.blockedPath,
      toolUseId: opts.toolUseID,
      description: undefined,
    };

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
    try {
      createPermissionRequest({
        id: permissionRequestId,
        sessionId: runtime.sessionId,
        sdkSessionId: runtime.lastSdkSessionId || '',
        toolName,
        toolInput: JSON.stringify(input),
        decisionReason: opts.decisionReason || '',
        expiresAt,
      });
    } catch (error) {
      console.warn('[claude-client] Failed to persist permission request to DB:', error);
    }

    emitRuntimeEvent(runtime, {
      type: 'permission_request',
      data: JSON.stringify(permEvent),
    });
    notifyPermissionRequest(toolName, input as Record<string, unknown>, runtime.telegramOpts).catch(() => {});

    runtime.activeTurn?.onRuntimeStatusChange?.('waiting_permission');
    const result = await registerPendingPermission(permissionRequestId, input, opts.signal);
    runtime.activeTurn?.onRuntimeStatusChange?.('running');
    return result;
  };

  queryOptions.hooks = {
    Notification: [{
      hooks: [async (input) => {
        const notif = input as NotificationHookInput;
        emitRuntimeEvent(runtime, {
          type: 'status',
          data: JSON.stringify({
            notification: true,
            title: notif.title,
            message: notif.message,
          }),
        });
        notifyGeneric(notif.title || '', notif.message || '', runtime.telegramOpts).catch(() => {});
        return {};
      }],
    }],
    PostToolUse: [{
      hooks: [async (input) => {
        const toolEvent = input as PostToolUseHookInput;
        emitRuntimeEvent(runtime, {
          type: 'tool_result',
          data: JSON.stringify({
            tool_use_id: toolEvent.tool_use_id,
            content: typeof toolEvent.tool_response === 'string'
              ? toolEvent.tool_response
              : JSON.stringify(toolEvent.tool_response),
            is_error: false,
          }),
        });

        if (toolEvent.tool_name === 'TodoWrite') {
          try {
            const toolInput = toolEvent.tool_input as {
              todos?: Array<{ content: string; status: string; activeForm?: string }>;
            };
            if (toolInput?.todos && Array.isArray(toolInput.todos)) {
              emitRuntimeEvent(runtime, {
                type: 'task_update',
                data: JSON.stringify({
                  session_id: runtime.sessionId,
                  todos: toolInput.todos.map((todo, i) => ({
                    id: String(i),
                    content: todo.content,
                    status: todo.status,
                    activeForm: todo.activeForm || '',
                  })),
                }),
              });
            }
          } catch (error) {
            console.warn('[claude-client] Failed to parse TodoWrite input:', error);
          }
        }
        return {};
      }],
    }],
  };

  queryOptions.stderr = (data: string) => {
    const cleaned = data
      .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
      .replace(/\x1B\([A-Z]/g, '')
      .replace(/\x1B[=>]/g, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (cleaned) {
      emitRuntimeEvent(runtime, {
        type: 'tool_output',
        data: cleaned,
      });
    }
  };

  runtime.conversation = query({
    prompt: runtime.inputQueue,
    options: queryOptions,
  });

  registerConversation(runtime.sessionId, createConversationHandle(runtime));
  getRuntimeMap().set(runtime.sessionId, runtime);
  void runRuntimeReader(runtime);
  return runtime;
}

function resolveRuntime(options: ClaudeStreamOptions, activeProvider?: ApiProvider): ClaudeRuntimeSessionState {
  const runtimeMap = getRuntimeMap();
  const existing = runtimeMap.get(options.sessionId);
  const existingHandle = getConversation(options.sessionId);
  const nextKey = buildRuntimeKey(options, activeProvider);

  if (existing && !existing.closed && existing.runtimeKey === nextKey) {
    if (!existingHandle) {
      registerConversation(options.sessionId, createConversationHandle(existing));
    }
    return existing;
  }

  if (existing && !existing.closed && existing.runtimeKey !== nextKey) {
    teardownRuntime(existing);
  }

  if (!existing && existingHandle) {
    unregisterConversation(options.sessionId);
  }

  return createRuntimeSession(options, activeProvider);
}

export function streamClaude(options: ClaudeStreamOptions): ReadableStream<string> {
  const {
    prompt,
    sessionId: _sessionId,
    model,
    abortController,
    permissionMode,
    files,
    toolTimeoutSeconds = 0,
    conversationHistory,
    onRuntimeStatusChange,
    imageAgentMode,
  } = options;

  let runtimeRef: ClaudeRuntimeSessionState | null = null;
  let turnRef: TurnStreamState | null = null;

  return new ReadableStream<string>({
    async start(controller) {
      const activeProvider: ApiProvider | undefined = options.provider ?? getActiveProvider();
      try {
        const runtime = resolveRuntime(options, activeProvider);
        runtimeRef = runtime;

        if (runtime.activeTurn && !runtime.activeTurn.finished) {
          throw new Error('Claude runtime is busy with another in-flight turn.');
        }

        const turn: TurnStreamState = {
          controller,
          abortController,
          onRuntimeStatusChange,
          toolTimeoutSeconds,
          finished: false,
          abortRequested: false,
          abortTimeout: null,
        };
        runtime.activeTurn = turn;
        turnRef = turn;
        turn.onRuntimeStatusChange?.('running');

        if (runtime.pendingEvents.length > 0) {
          for (const event of runtime.pendingEvents) {
            emitTurnEvent(turn, event);
          }
          runtime.pendingEvents = [];
        }

        const desiredPermissionMode: PermissionMode = runtime.skipPermissions
          ? 'bypassPermissions'
          : ((permissionMode as PermissionMode) || 'acceptEdits');
        if (runtime.currentPermissionMode !== desiredPermissionMode) {
          await runtime.conversation.setPermissionMode(desiredPermissionMode);
          runtime.currentPermissionMode = desiredPermissionMode;
        }

        if (model && model !== runtime.currentModel) {
          await runtime.conversation.setModel(model);
          runtime.currentModel = model;
        }

        const includeHistory = runtime.turnsStarted === 0 && runtime.includeHistoryOnFirstTurn;
        const userMessage = buildTurnUserMessage({
          prompt,
          files,
          workingDirectory: runtime.workingDirectory,
          imageAgentMode,
          includeHistory,
          conversationHistory,
          sdkSessionId: runtime.lastSdkSessionId || '',
        });
        runtime.turnsStarted += 1;
        runtime.inputQueue.enqueue(userMessage);

        if (abortController) {
          const handleAbort = () => {
            requestTurnAbort(runtime, turn);
          };
          if (abortController.signal.aborted) {
            handleAbort();
          } else {
            abortController.signal.addEventListener('abort', handleAbort, { once: true });
            turn.removeAbortListener = () => {
              abortController.signal.removeEventListener('abort', handleAbort);
            };
          }
        }
      } catch (error) {
        const errorMessage = buildErrorMessage(error, activeProvider);
        enqueueSSE(controller, { type: 'error', data: errorMessage });
        enqueueSSE(controller, { type: 'done', data: '' });
        controller.close();
        if (runtimeRef && turnRef && runtimeRef.activeTurn === turnRef) {
          runtimeRef.activeTurn = null;
        }
      }
    },

    cancel() {
      abortController?.abort();
      if (runtimeRef && turnRef && runtimeRef.activeTurn === turnRef) {
        requestTurnAbort(runtimeRef, turnRef);
      }
    },
  });
}
