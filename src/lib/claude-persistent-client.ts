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
  Query,
  McpServerStatus,
  ModelInfo,
  RewindFilesResult,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ClaudeStreamOptions,
  SSEEvent,
  TokenUsage,
  MCPServerConfig,
  PermissionRequestEvent,
  FileAttachment,
  ApiProvider,
} from '@/types';
import { isImageFile } from '@/types';
import { registerPendingPermission } from './permission-registry';
import { registerConversation, unregisterConversation } from './conversation-registry';
import {
  getSetting,
  getActiveProvider,
  getProvider,
  getSession,
  updateSdkSessionId,
  createPermissionRequest,
} from './db';
import { findClaudeBinary, findGitBash, getExpandedPath } from './platform';
import { notifyPermissionRequest, notifyGeneric } from './telegram-bot';
import { getRemoteConnection } from '@/lib/remote-connections';
import { createRemoteClaudeSpawner, buildRemoteClaudeUserMessage } from '@/lib/claude-remote-transport';
import type { ClaudeNativeConversationHandle } from '@/lib/agent/claude-native-controller';
import { updateClaudeCommandCache } from '@/lib/claude-command-metadata';
import { updateClaudeModelCache } from '@/lib/claude-model-discovery';
import os from 'os';
import fs from 'fs';
import path from 'path';

const GLOBAL_KEY = '__claudePersistentSessions__' as const;
const CONTROLLER_IDLE_TTL_MS = 30 * 60 * 1000;

interface PreparedRuntimeConfig {
  sessionId: string;
  workingDirectory: string;
  localWorkingDirectory: string;
  workspaceTransport: 'local' | 'ssh_direct';
  remoteConnectionId?: string;
  remotePath?: string;
  remoteEnv: Record<string, string>;
  model?: string;
  systemPrompt?: string;
  permissionMode: PermissionMode;
  mcpServers?: Record<string, MCPServerConfig>;
  activeProvider?: ApiProvider;
  sdkEnv: Record<string, string>;
  settingSources: Options['settingSources'];
  pathToClaudeCodeExecutable?: string;
  skipPermissions: boolean;
  resumeId?: string;
  startupNotification?: {
    title: string;
    message: string;
  };
  signature: string;
}

interface ActiveTurn {
  controller: ReadableStreamDefaultController<string>;
  onRuntimeStatusChange?: (status: string) => void;
  abortController?: AbortController;
  toolTimeoutSeconds: number;
  closed: boolean;
  cleanupAbortListener?: () => void;
}

function getRuntimeMap(): Map<string, ClaudePersistentSession> {
  if (!(globalThis as Record<string, unknown>)[GLOBAL_KEY]) {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = new Map<string, ClaudePersistentSession>();
  }
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, ClaudePersistentSession>;
}

function removeRuntime(sessionId: string) {
  getRuntimeMap().delete(sessionId);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sanitizeEnvValue(value: string): string {
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      clean[key] = sanitizeEnvValue(value);
    }
  }
  return clean;
}

function resolveScriptFromCmd(cmdPath: string): string | undefined {
  try {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const cmdDir = path.dirname(cmdPath);
    const patterns = [
      /"%~dp0\\([^"]*claude[^"]*\.js)"/i,
      /%~dp0\\(\S*claude\S*\.js)/i,
      /"%dp0%\\([^"]*claude[^"]*\.js)"/i,
    ];

    for (const re of patterns) {
      const match = content.match(re);
      if (match) {
        const resolved = path.normalize(path.join(cmdDir, match[1]));
        if (fs.existsSync(resolved)) return resolved;
      }
    }
  } catch {
    // ignore
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

function toSdkMcpConfig(servers: Record<string, MCPServerConfig>): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    const transport = config.type || 'stdio';

    switch (transport) {
      case 'sse': {
        if (!config.url) continue;
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
        if (!config.url) continue;
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
        if (!config.command) continue;
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

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

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

function buildPromptWithHistory(
  prompt: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (!history || history.length === 0) return prompt;

  const lines: string[] = ['<conversation_history>'];
  for (const msg of history) {
    let content = msg.content;
    if (msg.role === 'assistant' && content.startsWith('[')) {
      try {
        const blocks = JSON.parse(content);
        const parts: string[] = [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) parts.push(block.text);
          else if (block.type === 'tool_use') parts.push(`[Used tool: ${block.name}]`);
          else if (block.type === 'tool_result') {
            const resultStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            parts.push(`[Tool result: ${resultStr.slice(0, 500)}${resultStr.length > 500 ? '...' : ''}]`);
          }
        }
        content = parts.join('\n');
      } catch {
        // ignore
      }
    }
    lines.push(`${msg.role === 'user' ? 'Human' : 'Assistant'}: ${content}`);
  }
  lines.push('</conversation_history>');
  lines.push('');
  lines.push(prompt);
  return lines.join('\n');
}

function getUploadedFilePaths(files: FileAttachment[], workDir: string): string[] {
  const paths: string[] = [];
  let uploadDir: string | undefined;
  for (const file of files) {
    if (file.filePath) {
      paths.push(file.filePath);
    } else {
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

function normalizePermissionMode(value?: string | null): PermissionMode {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'plan') return 'plan';
  if (normalized === 'default' || normalized === 'ask') return 'default';
  if (normalized === 'bypasspermissions' || normalized === 'bypass') return 'bypassPermissions';
  if (normalized === 'dontask' || normalized === 'dont-ask') return 'dontAsk';
  return 'acceptEdits';
}

function buildSdkUserMessage(
  options: ClaudeStreamOptions,
  useHistory: boolean,
): SDKUserMessage {
  const {
    prompt,
    workingDirectory,
    files,
    imageAgentMode,
    conversationHistory,
  } = options;

  const basePrompt = useHistory
    ? buildPromptWithHistory(prompt, conversationHistory)
    : prompt;

  if (!files || files.length === 0) {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: basePrompt }],
      },
      parent_tool_use_id: null,
      session_id: '',
    };
  }

  const imageFiles = files.filter((file) => isImageFile(file.type));
  const nonImageFiles = files.filter((file) => !isImageFile(file.type));
  let textPrompt = basePrompt;

  if (nonImageFiles.length > 0) {
    const workDir = workingDirectory || os.homedir();
    const savedPaths = getUploadedFilePaths(nonImageFiles, workDir);
    const fileReferences = savedPaths
      .map((savedPath, index) => `[User attached file: ${savedPath} (${nonImageFiles[index].name})]`)
      .join('\n');
    textPrompt = `${fileReferences}\n\nPlease read the attached file(s) above using your Read tool, then respond to the user's message:\n\n${basePrompt}`;
  }

  if (imageFiles.length > 0) {
    const textWithImageRefs = imageAgentMode
      ? textPrompt
      : (() => {
          const workDir = workingDirectory || os.homedir();
          const imagePaths = getUploadedFilePaths(imageFiles, workDir);
          const imageReferences = imagePaths
            .map((savedPath, index) => `[User attached image: ${savedPath} (${imageFiles[index].name})]`)
            .join('\n');
          return `${imageReferences}\n\n${textPrompt}`;
        })();

    const contentBlocks: Array<
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
      | { type: 'text'; text: string }
    > = [];

    for (const image of imageFiles) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.type || 'image/png',
          data: image.data,
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
      session_id: '',
    };
  }

  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: textPrompt }],
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}

function formatClaudeError(error: unknown, activeProvider?: ApiProvider): string {
  const rawMessage = error instanceof Error ? error.message : 'Unknown error';
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

function prepareRuntimeConfig(options: ClaudeStreamOptions): PreparedRuntimeConfig {
  const activeProvider = options.provider ?? getActiveProvider();
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

  let appToken: string | undefined;
  let appBaseUrl: string | undefined;
  const remoteEnv: Record<string, string> = {};

  if (activeProvider && activeProvider.api_key) {
    for (const key of Object.keys(sdkEnv)) {
      if (key.startsWith('ANTHROPIC_')) {
        delete sdkEnv[key];
      }
    }

    sdkEnv.ANTHROPIC_AUTH_TOKEN = activeProvider.api_key;
    sdkEnv.ANTHROPIC_API_KEY = activeProvider.api_key;
    remoteEnv.ANTHROPIC_AUTH_TOKEN = activeProvider.api_key;
    remoteEnv.ANTHROPIC_API_KEY = activeProvider.api_key;
    if (activeProvider.base_url) {
      sdkEnv.ANTHROPIC_BASE_URL = activeProvider.base_url;
      remoteEnv.ANTHROPIC_BASE_URL = activeProvider.base_url;
    }

    try {
      const extraEnv = JSON.parse(activeProvider.extra_env || '{}');
      for (const [key, value] of Object.entries(extraEnv)) {
        if (typeof value === 'string') {
          if (value === '') {
            delete sdkEnv[key];
            delete remoteEnv[key];
          } else {
            sdkEnv[key] = value;
            remoteEnv[key] = value;
          }
        }
      }
    } catch {
      // ignore malformed extra_env
    }
  } else {
    appToken = getSetting('anthropic_auth_token');
    appBaseUrl = getSetting('anthropic_base_url');
    if (appToken) {
      sdkEnv.ANTHROPIC_AUTH_TOKEN = appToken;
      remoteEnv.ANTHROPIC_AUTH_TOKEN = appToken;
    }
    if (appBaseUrl) {
      sdkEnv.ANTHROPIC_BASE_URL = appBaseUrl;
      remoteEnv.ANTHROPIC_BASE_URL = appBaseUrl;
    }
  }

  let pathToClaudeCodeExecutable: string | undefined;
  const claudePath = findClaudePath();
  if (claudePath) {
    const ext = path.extname(claudePath).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      pathToClaudeCodeExecutable = resolveScriptFromCmd(claudePath);
    } else {
      pathToClaudeCodeExecutable = claudePath;
    }
  }

  const skipPermissions = getSetting('dangerously_skip_permissions') === 'true';
  const localWorkingDirectory = options.workingDirectory || os.homedir();
  const isRemote = options.workspaceTransport === 'ssh_direct';
  const workingDirectory = isRemote
    ? (options.remotePath || localWorkingDirectory)
    : localWorkingDirectory;
  let resumeId = options.sdkSessionId;
  let startupNotification: PreparedRuntimeConfig['startupNotification'];

  if (resumeId && localWorkingDirectory && !fs.existsSync(localWorkingDirectory)) {
    updateSdkSessionId(options.sessionId, '');
    resumeId = undefined;
    startupNotification = {
      title: 'Session fallback',
      message: 'Original working directory no longer exists. Starting fresh conversation.',
    };
  }

  const permissionMode = skipPermissions
    ? 'bypassPermissions'
    : normalizePermissionMode(options.permissionMode);

  const activeProviderFingerprint = activeProvider
    ? {
        id: activeProvider.id,
        name: activeProvider.name,
        api_key: activeProvider.api_key,
        base_url: activeProvider.base_url,
        extra_env: activeProvider.extra_env,
      }
    : {
        appToken,
        appBaseUrl,
      };

  const signature = stableSerialize({
    cwd: workingDirectory,
    localWorkingDirectory,
    workspaceTransport: isRemote ? options.workspaceTransport! : 'local',
    remoteConnectionId: options.remoteConnectionId || '',
    remotePath: options.remotePath || '',
    remoteEnv: sanitizeEnv(remoteEnv),
    systemPrompt: options.systemPrompt || '',
    mcpServers: options.mcpServers || {},
    provider: activeProviderFingerprint,
    skipPermissions,
    settingSources: activeProvider?.api_key ? ['project', 'local'] : ['user', 'project', 'local'],
    pathToClaudeCodeExecutable: pathToClaudeCodeExecutable || '',
  });

  return {
    sessionId: options.sessionId,
    workingDirectory,
    localWorkingDirectory,
    workspaceTransport: isRemote ? options.workspaceTransport! : 'local',
    remoteConnectionId: options.remoteConnectionId || undefined,
    remotePath: options.remotePath || undefined,
    remoteEnv: sanitizeEnv(remoteEnv),
    model: options.model,
    systemPrompt: options.systemPrompt,
    permissionMode,
    mcpServers: options.mcpServers,
    activeProvider: activeProvider || undefined,
    sdkEnv: sanitizeEnv(sdkEnv),
    settingSources: activeProvider?.api_key ? ['project', 'local'] : ['user', 'project', 'local'],
    pathToClaudeCodeExecutable,
    skipPermissions,
    resumeId,
    startupNotification,
    signature,
  };
}

class AsyncSdkUserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  enqueue(message: SDKUserMessage) {
    if (this.closed) {
      throw new Error('Cannot enqueue into a closed Claude message queue');
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
    } else {
      this.queue.push(message);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ done: true, value: undefined as never });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        if (this.queue.length > 0) {
          return { done: false, value: this.queue.shift() as SDKUserMessage };
        }
        if (this.closed) {
          return { done: true, value: undefined as never };
        }
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

class ClaudePersistentSession implements ClaudeNativeConversationHandle {
  private readonly sessionId: string;
  private config: PreparedRuntimeConfig;
  private inputQueue: AsyncSdkUserMessageQueue;
  private queryHandle: Query;
  private iterator: AsyncIterator<SDKMessage>;
  private activeTurn: ActiveTurn | null = null;
  private nativeSessionId = '';
  private hasRuntimeContext: boolean;
  private currentModel?: string;
  private currentPermissionMode: PermissionMode;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: PreparedRuntimeConfig) {
    this.sessionId = config.sessionId;
    this.config = config;
    this.hasRuntimeContext = Boolean(config.resumeId);
    this.currentModel = config.model;
    this.currentPermissionMode = config.permissionMode;
    this.inputQueue = new AsyncSdkUserMessageQueue();
    this.queryHandle = this.createQueryHandle(config);
    this.iterator = this.queryHandle[Symbol.asyncIterator]();
    registerConversation(this.sessionId, this);
  }

  canReuse(config: PreparedRuntimeConfig): boolean {
    return this.config.signature === config.signature;
  }

  reconfigure(config: PreparedRuntimeConfig) {
    this.destroy(false);
    this.config = config;
    this.hasRuntimeContext = Boolean(config.resumeId);
    this.currentModel = config.model;
    this.currentPermissionMode = config.permissionMode;
    this.inputQueue = new AsyncSdkUserMessageQueue();
    this.queryHandle = this.createQueryHandle(config);
    this.iterator = this.queryHandle[Symbol.asyncIterator]();
    registerConversation(this.sessionId, this);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.touch();
    await this.queryHandle.setPermissionMode(mode);
    this.currentPermissionMode = mode;
  }

  async setModel(model?: string): Promise<void> {
    this.touch();
    await this.queryHandle.setModel(model);
    this.currentModel = model;
  }

  async supportedCommands(): Promise<SlashCommand[]> {
    this.touch();
    const commands = await this.queryHandle.supportedCommands();
    updateClaudeCommandCache(commands);
    return commands;
  }

  async supportedModels(): Promise<ModelInfo[]> {
    this.touch();
    const models = await this.queryHandle.supportedModels();
    updateClaudeModelCache(models);
    return models;
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    this.touch();
    return this.queryHandle.mcpServerStatus();
  }

  async rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult> {
    this.touch();
    return this.queryHandle.rewindFiles(userMessageId, options);
  }

  async initializationResult() {
    this.touch();
    return this.queryHandle.initializationResult();
  }

  async accountInfo() {
    this.touch();
    return this.queryHandle.accountInfo();
  }

  async runTurn(options: ClaudeStreamOptions, controller: ReadableStreamDefaultController<string>) {
    if (this.activeTurn) {
      throw new Error(`Claude runtime session ${this.sessionId} is already processing a turn`);
    }

    this.clearIdleTimer();
    const turn: ActiveTurn = {
      controller,
      onRuntimeStatusChange: options.onRuntimeStatusChange,
      abortController: options.abortController,
      toolTimeoutSeconds: options.toolTimeoutSeconds || 0,
      closed: false,
    };
    this.activeTurn = turn;

    if (turn.abortController) {
      const onAbort = () => {
        void this.interruptCurrentTurn();
      };
      turn.abortController.signal.addEventListener('abort', onAbort, { once: true });
      turn.cleanupAbortListener = () => {
        turn.abortController?.signal.removeEventListener('abort', onAbort);
      };
    }

    try {
      if (this.config.startupNotification) {
        this.emit({
          type: 'status',
          data: JSON.stringify({
            notification: true,
            title: this.config.startupNotification.title,
            message: this.config.startupNotification.message,
          }),
        });
        this.config.startupNotification = undefined;
      }

      const isFirstTurn = !this.hasRuntimeContext;
      await this.applyTurnConfiguration(options);
      await this.executeTurn(options, isFirstTurn);
      this.hasRuntimeContext = true;
      // Proactively cache command + model metadata after first successful turn
      if (isFirstTurn) {
        this.queryHandle.supportedCommands()
          .then((cmds) => updateClaudeCommandCache(cmds))
          .catch(() => { /* silent — will populate on next supportedCommands() call */ });
        this.queryHandle.supportedModels()
          .then((models) => updateClaudeModelCache(models))
          .catch(() => { /* silent — will populate on next supportedModels() call */ });
      }
      this.emit({ type: 'done', data: '' });
      this.closeTurnController();
    } catch (error) {
      if (this.shouldRetryWithoutResume(error)) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.warn('[claude-persistent-client] Resume failed, retrying without resume:', errMsg);
        try {
          updateSdkSessionId(this.sessionId, '');
        } catch {
          // best effort
        }
        this.emit({
          type: 'status',
          data: JSON.stringify({
            notification: true,
            title: 'Session fallback',
            message: 'Previous session could not be resumed. Starting fresh conversation.',
          }),
        });
        this.reconfigure({
          ...this.config,
          resumeId: undefined,
          startupNotification: undefined,
        });
        this.activeTurn = turn;
        await this.applyTurnConfiguration(options);
        await this.executeTurn(options, true);
        this.hasRuntimeContext = true;
        this.emit({ type: 'done', data: '' });
        this.closeTurnController();
      } else {
        console.error('[claude-persistent-client] Stream error:', error);
        const errorMessage = formatClaudeError(error, this.config.activeProvider);
        this.emit({ type: 'error', data: errorMessage });
        this.emit({ type: 'done', data: '' });
        this.closeTurnController();
        // Fatal turn errors usually leave the runtime in an uncertain state.
        this.destroy(true);
        removeRuntime(this.sessionId);
      }
    } finally {
      turn.cleanupAbortListener?.();
      if (this.activeTurn === turn) {
        this.activeTurn = null;
      }
      this.scheduleIdleTimer();
    }
  }

  async interruptCurrentTurn() {
    try {
      await this.queryHandle.interrupt();
    } catch {
      // best effort
    }
  }

  cancelClientStream() {
    if (!this.activeTurn || this.activeTurn.closed) {
      return;
    }
    void this.interruptCurrentTurn();
  }

  dispose() {
    this.destroy(true);
    removeRuntime(this.sessionId);
  }

  private touch() {
    this.clearIdleTimer();
    this.scheduleIdleTimer();
  }

  private scheduleIdleTimer() {
      this.clearIdleTimer();
      const timeout = setTimeout(() => {
        if (!this.activeTurn) {
          this.destroy(true);
          removeRuntime(this.sessionId);
        }
      }, CONTROLLER_IDLE_TTL_MS);
    timeout.unref?.();
    this.idleTimer = timeout;
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private closeTurnController() {
    if (!this.activeTurn || this.activeTurn.closed) return;
    this.activeTurn.closed = true;
    try {
      this.activeTurn.controller.close();
    } catch {
      // already closed
    }
  }

  private emit(event: SSEEvent) {
    const turn = this.activeTurn;
    if (!turn || turn.closed) return;
    try {
      turn.controller.enqueue(formatSSE(event));
    } catch {
      // client stream closed
    }
  }

  private shouldRetryWithoutResume(error: unknown): boolean {
    return Boolean(this.config.resumeId)
      && !this.hasRuntimeContext
      && error instanceof Error;
  }

  private async buildUserMessage(options: ClaudeStreamOptions, useHistory: boolean) {
    if (this.config.workspaceTransport === 'ssh_direct' && this.config.remoteConnectionId && this.config.remotePath) {
      const connection = getRemoteConnection(this.config.remoteConnectionId);
      if (!connection) {
        throw new Error('Remote connection not found for Claude runtime.');
      }
      return buildRemoteClaudeUserMessage(options, useHistory, connection, this.config.remotePath);
    }
    return buildSdkUserMessage(options, useHistory);
  }

  private async executeTurn(options: ClaudeStreamOptions, useHistory: boolean) {
    const userMessage = await this.buildUserMessage(options, useHistory);
    this.inputQueue.enqueue(userMessage);

    while (true) {
      const next = await this.iterator.next();
      if (next.done) {
        throw new Error('Claude runtime ended unexpectedly');
      }

      await this.handleSdkMessage(next.value);
      if (next.value.type === 'result') {
        break;
      }
    }
  }

  private async applyTurnConfiguration(options: ClaudeStreamOptions) {
    const desiredModel = options.model;
    const desiredPermissionMode = this.config.skipPermissions
      ? 'bypassPermissions'
      : normalizePermissionMode(options.permissionMode);

    if (desiredModel !== this.currentModel) {
      await this.queryHandle.setModel(desiredModel);
      this.currentModel = desiredModel;
    }

    if (desiredPermissionMode !== this.currentPermissionMode) {
      await this.queryHandle.setPermissionMode(desiredPermissionMode);
      this.currentPermissionMode = desiredPermissionMode;
    }
  }

  private async handleSdkMessage(message: SDKMessage) {
    if (this.activeTurn?.abortController?.signal.aborted && message.type !== 'result') {
      // Continue consuming until the result event terminates the interrupted turn.
    }

    switch (message.type) {
      case 'assistant': {
        const assistantMsg = message as SDKAssistantMessage;
        for (const block of assistantMsg.message.content) {
          if (block.type === 'tool_use') {
            this.emit({
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
        const userMsg = message as SDKUserMessage;
        const content = userMsg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const resultContent = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .filter((item: { type: string }) => item.type === 'text')
                      .map((item: { text: string }) => item.text)
                      .join('\n')
                  : String(block.content ?? '');
              this.emit({
                type: 'tool_result',
                data: JSON.stringify({
                  tool_use_id: block.tool_use_id,
                  content: resultContent,
                  is_error: block.is_error || false,
                }),
              });
            }
          }
        }
        break;
      }
      case 'stream_event': {
        const streamEvent = message as SDKPartialAssistantMessage;
        const evt = streamEvent.event;
        if (evt.type === 'content_block_delta' && 'delta' in evt) {
          const delta = evt.delta;
          if ('text' in delta && delta.text) {
            this.emit({ type: 'text', data: delta.text });
          }
        }
        break;
      }
      case 'system': {
        const sysMsg = message as SDKSystemMessage;
        if ('subtype' in sysMsg) {
          if (sysMsg.subtype === 'init') {
            this.nativeSessionId = sysMsg.session_id;
            if (sysMsg.model) {
              this.currentModel = sysMsg.model;
            }
            this.emit({
              type: 'status',
              data: JSON.stringify({
                session_id: sysMsg.session_id,
                model: sysMsg.model,
                tools: sysMsg.tools,
              }),
            });
          } else if (sysMsg.subtype === 'status') {
            const statusMsg = sysMsg as SDKSystemMessage & { permissionMode?: string };
            if (statusMsg.permissionMode) {
              this.emit({
                type: 'mode_changed',
                data: statusMsg.permissionMode,
              });
            }
          }
        }
        break;
      }
      case 'tool_progress': {
        const progressMsg = message as SDKToolProgressMessage;
        this.emit({
          type: 'tool_output',
          data: JSON.stringify({
            _progress: true,
            tool_use_id: progressMsg.tool_use_id,
            tool_name: progressMsg.tool_name,
            elapsed_time_seconds: progressMsg.elapsed_time_seconds,
          }),
        });
        if (
          this.activeTurn
          && this.activeTurn.toolTimeoutSeconds > 0
          && progressMsg.elapsed_time_seconds >= this.activeTurn.toolTimeoutSeconds
        ) {
          this.emit({
            type: 'tool_timeout',
            data: JSON.stringify({
              tool_name: progressMsg.tool_name,
              elapsed_seconds: Math.round(progressMsg.elapsed_time_seconds),
            }),
          });
          await this.queryHandle.interrupt();
        }
        break;
      }
      case 'result': {
        const resultMsg = message as SDKResultMessage;
        this.emit({
          type: 'result',
          data: JSON.stringify({
            subtype: resultMsg.subtype,
            is_error: resultMsg.is_error,
            num_turns: resultMsg.num_turns,
            duration_ms: resultMsg.duration_ms,
            usage: extractTokenUsage(resultMsg),
            session_id: resultMsg.session_id,
          }),
        });
        break;
      }
      default: {
        if ((message as { type: string }).type === 'keep_alive') {
          this.emit({ type: 'keep_alive', data: '' });
        }
        break;
      }
    }
  }

  private handleStderr(data: string) {
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
      this.emit({ type: 'tool_output', data: cleaned });
    }
  }

  private createQueryHandle(config: PreparedRuntimeConfig): Query {
    const queryOptions: Options = {
      cwd: config.workingDirectory,
      includePartialMessages: true,
      enableFileCheckpointing: true,
      permissionMode: config.permissionMode,
      env: config.sdkEnv,
      settingSources: config.settingSources,
      canUseTool: async (toolName, input, opts) => {
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
            sessionId: this.sessionId,
            sdkSessionId: this.nativeSessionId || config.resumeId || '',
            toolName,
            toolInput: JSON.stringify(input),
            decisionReason: opts.decisionReason || '',
            expiresAt,
          });
        } catch (error) {
          console.warn('[claude-persistent-client] Failed to persist permission request:', error);
        }

        this.emit({
          type: 'permission_request',
          data: JSON.stringify(permEvent),
        });

        notifyPermissionRequest(toolName, input as Record<string, unknown>, {
          sessionId: this.sessionId,
          sessionTitle: undefined,
          workingDirectory: config.workingDirectory,
        }).catch(() => {});

        this.activeTurn?.onRuntimeStatusChange?.('waiting_permission');
        const result = await registerPendingPermission(permissionRequestId, input, opts.signal);
        this.activeTurn?.onRuntimeStatusChange?.('running');
        return result;
      },
      hooks: {
        Notification: [{
          hooks: [async (input) => {
            const notif = input as NotificationHookInput;
            this.emit({
              type: 'status',
              data: JSON.stringify({
                notification: true,
                title: notif.title,
                message: notif.message,
              }),
            });
            notifyGeneric(
              notif.title || '',
              notif.message || '',
              {
                sessionId: this.sessionId,
                sessionTitle: undefined,
                workingDirectory: config.workingDirectory,
              },
            ).catch(() => {});
            return {};
          }],
        }],
        PostToolUse: [{
          hooks: [async (input) => {
            const toolEvent = input as PostToolUseHookInput;
            this.emit({
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
                  this.emit({
                    type: 'task_update',
                    data: JSON.stringify({
                      session_id: this.sessionId,
                      todos: toolInput.todos.map((todo, index) => ({
                        id: String(index),
                        content: todo.content,
                        status: todo.status,
                        activeForm: todo.activeForm || '',
                      })),
                    }),
                  });
                }
              } catch {
                // ignore malformed TodoWrite payload
              }
            }

            return {};
          }],
        }],
      },
      stderr: (data: string) => {
        this.handleStderr(data);
      },
    };

    if (config.skipPermissions) {
      queryOptions.allowDangerouslySkipPermissions = true;
    }
    if (config.workspaceTransport === 'ssh_direct' && config.remoteConnectionId && config.remotePath) {
      const connection = getRemoteConnection(config.remoteConnectionId);
      if (!connection) {
        throw new Error('Remote connection not found for Claude runtime.');
      }
      queryOptions.spawnClaudeCodeProcess = createRemoteClaudeSpawner(connection, config.remoteEnv);
    } else if (config.pathToClaudeCodeExecutable) {
      queryOptions.pathToClaudeCodeExecutable = config.pathToClaudeCodeExecutable;
    }
    if (config.model) {
      queryOptions.model = config.model;
    }
    if (config.systemPrompt) {
      queryOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: config.systemPrompt,
      };
    }
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      queryOptions.mcpServers = toSdkMcpConfig(config.mcpServers);
    }
    if (config.resumeId) {
      queryOptions.resume = config.resumeId;
    }

    return query({
      prompt: this.inputQueue,
      options: queryOptions,
    });
  }

  private destroy(removeRegistration: boolean) {
    this.clearIdleTimer();
    try {
      this.queryHandle.close();
    } catch {
      // ignore
    }
    this.inputQueue.close();
    if (removeRegistration) {
      unregisterConversation(this.sessionId);
    }
  }
}

function getOrCreateRuntime(options: ClaudeStreamOptions): ClaudePersistentSession {
  const config = prepareRuntimeConfig(options);
  const map = getRuntimeMap();
  const existing = map.get(options.sessionId);
  if (existing) {
    if (existing.canReuse(config)) {
      return existing;
    }
    existing.dispose();
  }

  const runtime = new ClaudePersistentSession(config);
  map.set(options.sessionId, runtime);
  return runtime;
}

export function ensureClaudePersistentRuntime(sessionId: string): ClaudeNativeConversationHandle | null {
  const session = getSession(sessionId);
  if (!session) {
    return null;
  }

  const resumeId = session.engine_session_id || session.sdk_session_id || '';
  if (!resumeId) {
    return null;
  }

  const provider = session.provider_id && session.provider_id !== 'env'
    ? getProvider(session.provider_id)
    : undefined;

  return getOrCreateRuntime({
    prompt: '',
    sessionId,
    sdkSessionId: resumeId,
    model: session.model || undefined,
    systemPrompt: session.system_prompt || undefined,
    workingDirectory: session.sdk_cwd || session.working_directory || undefined,
    workspaceTransport: session.workspace_transport,
    remoteConnectionId: session.remote_connection_id || undefined,
    remotePath: session.remote_path || undefined,
    permissionMode: session.mode || 'code',
    provider,
  });
}

export function streamClaudePersistent(options: ClaudeStreamOptions): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      const runtime = getOrCreateRuntime(options);
      await runtime.runTurn(options, controller);
    },
    cancel() {
      const runtime = getRuntimeMap().get(options.sessionId);
      if (runtime) {
        runtime.cancelClientStream();
      }
    },
  });
}
