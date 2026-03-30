import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { buildCodexSpawnCommand } from '@/lib/codex-cli';

type JsonRpcId = string | number;

type JsonRpcRequest = {
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id?: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
  method?: string;
  params?: unknown;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

export type CodexAppServerModel = {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
  defaultReasoningEffort?: string;
  supportsPersonality?: boolean;
  isDefault?: boolean;
  inputModalities?: string[];
};

export type CodexAppServerConfig = {
  model?: string | null;
  model_provider?: string | null;
  approval_policy?: string | null;
  sandbox_mode?: string | null;
  web_search?: string | null;
  profile?: string | null;
  model_reasoning_effort?: string | null;
  model_reasoning_summary?: string | null;
  model_verbosity?: string | null;
  service_tier?: string | null;
  [key: string]: unknown;
};

export type CodexAppServerAccount = {
  type: 'apiKey';
} | {
  type: 'chatgpt';
  email: string;
  planType: string;
};

export type CodexThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags?: string[] };

export type CodexAppServerThread = {
  id: string;
  preview?: string;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  cliVersion?: string;
  source?: string;
  name?: string | null;
  status?: CodexThreadStatus;
};

export type CodexAppServerTurn = {
  id: string;
  status?: string;
};

export type CodexAppServerNotification = {
  method: string;
  params?: unknown;
};

export type CodexAppServerTurnLifecycle = {
  threadId: string;
  turnId: string;
  status: string;
  lastAgentMessage: string;
  sawContextCompaction: boolean;
  sawEnteredReviewMode: boolean;
  sawExitedReviewMode: boolean;
};

export type CodexAppServerMcpServerStatus = {
  name: string;
  tools?: Record<string, unknown>;
  resources?: unknown[];
  resourceTemplates?: unknown[];
  authStatus?: string;
};

export type CodexAppServerSkill = {
  name?: string;
  description?: string;
  isEnabled?: boolean;
  source?: string;
};

export type CodexAppServerApp = {
  id?: string;
  name?: string;
  description?: string;
  isAccessible?: boolean;
  isEnabled?: boolean;
};

export type CodexAppServerExperimentalFeature = {
  name?: string;
  displayName?: string | null;
  description?: string | null;
  announcement?: string | null;
  stage?: string;
  enabled?: boolean;
  defaultEnabled?: boolean;
};

export type CodexAppServerCollaborationMode = {
  id?: string;
  name?: string;
  description?: string;
  isDefault?: boolean;
};

export interface CodexAppServerClient {
  listModels(params?: { includeHidden?: boolean; limit?: number }): Promise<CodexAppServerModel[]>;
  readConfig(params?: { cwd?: string | null; includeLayers?: boolean }): Promise<CodexAppServerConfig>;
  readAccount(params?: { refreshToken?: boolean }): Promise<{
    account: CodexAppServerAccount | null;
    requiresOpenaiAuth: boolean;
  }>;
  readThread(params: { threadId: string; includeTurns?: boolean }): Promise<CodexAppServerThread>;
  resumeThread(params: {
    threadId: string;
    cwd?: string | null;
    model?: string | null;
    modelProvider?: string | null;
    approvalPolicy?: string | null;
    persistExtendedHistory?: boolean;
  }): Promise<CodexAppServerThread>;
  forkThread(params: { threadId: string }): Promise<CodexAppServerThread>;
  listMcpServerStatus(params?: { cursor?: string | null; limit?: number }): Promise<CodexAppServerMcpServerStatus[]>;
  listSkills(params?: { cwds?: string[]; forceReload?: boolean }): Promise<CodexAppServerSkill[]>;
  listApps(params?: { cursor?: string | null; limit?: number }): Promise<CodexAppServerApp[]>;
  listExperimentalFeatures(): Promise<CodexAppServerExperimentalFeature[]>;
  listCollaborationModes(): Promise<CodexAppServerCollaborationMode[]>;
  listThreads(params?: { cursor?: string | null; limit?: number; archived?: boolean }): Promise<CodexAppServerThread[]>;
  writeConfigValue(params: { key: string; value: unknown; mergeStrategy?: string }): Promise<void>;
  compactThread(params: { threadId: string }): Promise<void>;
  startReview(params: {
    threadId: string;
    delivery?: 'inline' | 'detached';
    target?:
      | { type: 'uncommittedChanges' }
      | { type: 'baseBranch'; branch: string }
      | { type: 'commit'; sha: string; title: string | null }
      | { type: 'custom'; instructions: string };
  }): Promise<{
    turn: CodexAppServerTurn;
    reviewThreadId: string;
  }>;
  waitForTurnCompletion(params: {
    threadId: string;
    turnId?: string;
    timeoutMs?: number;
  }): Promise<CodexAppServerTurnLifecycle>;
  subscribeNotifications(listener: (notification: CodexAppServerNotification) => void): () => void;
}

class CodexAppServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAppServerError';
  }
}

class CodexAppServerSession implements CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderr = '';
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly listeners = new Set<(notification: CodexAppServerNotification) => void>();
  private closed = false;

  constructor(
    private readonly requestTimeoutMs: number,
    private readonly codexPathOverride?: string,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;

    const codex = buildCodexSpawnCommand(['app-server', '--listen', 'stdio://'], { executablePathOverride: this.codexPathOverride });
    const child = spawn(codex.command, codex.args, {
      env: codex.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.on('error', (error) => {
      this.failAllPending(new CodexAppServerError(
        `Failed to start Codex app-server: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });

    child.on('exit', (code, signal) => {
      if (this.closed) return;
      const suffix = this.stderr.trim() ? ` ${this.stderr.trim()}` : '';
      this.failAllPending(new CodexAppServerError(
        `Codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}).${suffix}`,
      ));
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr += chunk.toString();
    });

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString();
      let newlineIndex = this.buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line) {
          this.handleLine(line);
        }
        newlineIndex = this.buffer.indexOf('\n');
      }
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'codepilot',
        title: 'CodePilot',
        version: process.env.NEXT_PUBLIC_APP_VERSION || 'dev',
      },
    });
    this.notify('initialized', {});
  }

  async close(): Promise<void> {
    this.closed = true;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerError('Codex app-server client closed before response.'));
    }
    this.pending.clear();
    this.listeners.clear();

    const child = this.child;
    this.child = null;
    this.buffer = '';

    if (!child || child.killed) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore kill failures
    }
  }

  async listModels(params: { includeHidden?: boolean; limit?: number } = {}): Promise<CodexAppServerModel[]> {
    const result = await this.request<{ data?: unknown }>('model/list', {
      includeHidden: params.includeHidden ?? false,
      limit: params.limit ?? 128,
    });
    return Array.isArray(result?.data) ? (result.data as CodexAppServerModel[]) : [];
  }

  async readConfig(params: { cwd?: string | null; includeLayers?: boolean } = {}): Promise<CodexAppServerConfig> {
    const result = await this.request<{ config?: unknown }>('config/read', {
      includeLayers: params.includeLayers ?? false,
      cwd: params.cwd ?? null,
    });
    return isRecord(result?.config) ? (result.config as CodexAppServerConfig) : {};
  }

  async readAccount(params: { refreshToken?: boolean } = {}): Promise<{
    account: CodexAppServerAccount | null;
    requiresOpenaiAuth: boolean;
  }> {
    const result = await this.request<{
      account?: CodexAppServerAccount | null;
      requiresOpenaiAuth?: unknown;
    }>('account/read', {
      refreshToken: params.refreshToken ?? false,
    });

    return {
      account: isAccount(result?.account) ? result.account : null,
      requiresOpenaiAuth: result?.requiresOpenaiAuth === true,
    };
  }

  async readThread(params: { threadId: string; includeTurns?: boolean }): Promise<CodexAppServerThread> {
    const result = await this.request<{ thread?: unknown }>('thread/read', {
      threadId: params.threadId,
      includeTurns: params.includeTurns ?? false,
    });
    return isRecord(result?.thread) ? (result.thread as CodexAppServerThread) : { id: params.threadId };
  }

  async resumeThread(params: {
    threadId: string;
    cwd?: string | null;
    model?: string | null;
    modelProvider?: string | null;
    approvalPolicy?: string | null;
    persistExtendedHistory?: boolean;
  }): Promise<CodexAppServerThread> {
    const result = await this.request<{ thread?: unknown }>('thread/resume', {
      threadId: params.threadId,
      cwd: params.cwd ?? null,
      model: params.model ?? null,
      modelProvider: params.modelProvider ?? null,
      approvalPolicy: params.approvalPolicy ?? null,
      persistExtendedHistory: params.persistExtendedHistory ?? false,
    });
    return isRecord(result?.thread) ? (result.thread as CodexAppServerThread) : { id: params.threadId };
  }

  async forkThread(params: { threadId: string }): Promise<CodexAppServerThread> {
    const result = await this.request<{ thread?: unknown }>('thread/fork', {
      threadId: params.threadId,
    });
    return isRecord(result?.thread) ? (result.thread as CodexAppServerThread) : { id: '' };
  }

  async listMcpServerStatus(params: { cursor?: string | null; limit?: number } = {}): Promise<CodexAppServerMcpServerStatus[]> {
    const result = await this.request<{ data?: unknown }>('mcpServerStatus/list', {
      cursor: params.cursor ?? null,
      limit: params.limit ?? 128,
    });
    return Array.isArray(result?.data) ? (result.data as CodexAppServerMcpServerStatus[]) : [];
  }

  async listSkills(params: { cwds?: string[]; forceReload?: boolean } = {}): Promise<CodexAppServerSkill[]> {
    const result = await this.request<{ data?: unknown }>('skills/list', {
      cwds: params.cwds ?? [],
      forceReload: params.forceReload ?? false,
    });
    return Array.isArray(result?.data) ? (result.data as CodexAppServerSkill[]) : [];
  }

  async listApps(params: { cursor?: string | null; limit?: number } = {}): Promise<CodexAppServerApp[]> {
    const result = await this.request<{ data?: unknown }>('app/list', {
      cursor: params.cursor ?? null,
      limit: params.limit ?? 128,
    });
    return Array.isArray(result?.data) ? (result.data as CodexAppServerApp[]) : [];
  }

  async listExperimentalFeatures(): Promise<CodexAppServerExperimentalFeature[]> {
    const result = await this.request<{ data?: unknown }>('experimentalFeature/list', {});
    return Array.isArray(result?.data) ? (result.data as CodexAppServerExperimentalFeature[]) : [];
  }

  async listCollaborationModes(): Promise<CodexAppServerCollaborationMode[]> {
    const result = await this.request<{ data?: unknown }>('collaborationMode/list', {});
    return Array.isArray(result?.data) ? (result.data as CodexAppServerCollaborationMode[]) : [];
  }

  async listThreads(params: { cursor?: string | null; limit?: number; archived?: boolean } = {}): Promise<CodexAppServerThread[]> {
    const result = await this.request<{ data?: unknown }>('thread/list', {
      cursor: params.cursor ?? null,
      limit: params.limit ?? 50,
      archived: params.archived ?? false,
    });
    return Array.isArray(result?.data) ? (result.data as CodexAppServerThread[]) : [];
  }

  async writeConfigValue(params: { key: string; value: unknown; mergeStrategy?: string }): Promise<void> {
    await this.request('config/value/write', {
      keyPath: params.key,
      value: params.value,
      mergeStrategy: params.mergeStrategy ?? 'replace',
    });
  }

  async compactThread(params: { threadId: string }): Promise<void> {
    await this.request('thread/compact/start', { threadId: params.threadId });
  }

  async startReview(params: {
    threadId: string;
    delivery?: 'inline' | 'detached';
    target?:
      | { type: 'uncommittedChanges' }
      | { type: 'baseBranch'; branch: string }
      | { type: 'commit'; sha: string; title: string | null }
      | { type: 'custom'; instructions: string };
  }): Promise<{
    turn: CodexAppServerTurn;
    reviewThreadId: string;
  }> {
    const result = await this.request<{
      turn?: unknown;
      reviewThreadId?: unknown;
    }>('review/start', {
      threadId: params.threadId,
      target: params.target || { type: 'uncommittedChanges' },
      delivery: params.delivery ?? 'inline',
    });

    const turn = isRecord(result?.turn) ? (result.turn as CodexAppServerTurn) : { id: '' };
    return {
      turn,
      reviewThreadId: typeof result?.reviewThreadId === 'string' ? result.reviewThreadId : params.threadId,
    };
  }

  async waitForTurnCompletion(params: {
    threadId: string;
    turnId?: string;
    timeoutMs?: number;
  }): Promise<CodexAppServerTurnLifecycle> {
    const timeoutMs = params.timeoutMs ?? Math.max(this.requestTimeoutMs * 6, 30000);

    return new Promise<CodexAppServerTurnLifecycle>((resolve, reject) => {
      let activeTurnId = params.turnId || '';
      let lastAgentMessage = '';
      let sawContextCompaction = false;
      let sawEnteredReviewMode = false;
      let sawExitedReviewMode = false;

      const done = (result: CodexAppServerTurnLifecycle) => {
        unsubscribe();
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        unsubscribe();
        reject(new CodexAppServerError(`Timed out waiting for Codex turn completion on thread ${params.threadId}`));
      }, timeoutMs);

      const unsubscribe = this.subscribeNotifications((notification) => {
        const payload = isRecord(notification.params) ? notification.params : null;
        if (!payload) return;

        const payloadThreadId = typeof payload.threadId === 'string' ? payload.threadId : '';
        if (payloadThreadId && payloadThreadId !== params.threadId) {
          return;
        }

        if (notification.method === 'turn/started') {
          const turn = isRecord(payload.turn) ? payload.turn : null;
          const turnId = turn && typeof turn.id === 'string' ? turn.id : '';
          if (!activeTurnId && turnId) {
            activeTurnId = turnId;
          }
          return;
        }

        if (notification.method === 'item/agentMessage/delta') {
          const turnId = typeof payload.turnId === 'string' ? payload.turnId : '';
          if (activeTurnId && turnId && turnId !== activeTurnId) {
            return;
          }
          if (typeof payload.delta === 'string') {
            lastAgentMessage += payload.delta;
          }
          return;
        }

        if (notification.method === 'item/completed') {
          const turnId = typeof payload.turnId === 'string' ? payload.turnId : '';
          if (activeTurnId && turnId && turnId !== activeTurnId) {
            return;
          }

          const item = isRecord(payload.item) ? payload.item : null;
          if (!item || typeof item.type !== 'string') return;

          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            lastAgentMessage = item.text;
          }
          if (item.type === 'contextCompaction') {
            sawContextCompaction = true;
          }
          if (item.type === 'enteredReviewMode') {
            sawEnteredReviewMode = true;
          }
          if (item.type === 'exitedReviewMode') {
            sawExitedReviewMode = true;
          }
          return;
        }

        if (notification.method === 'turn/completed') {
          const turn = isRecord(payload.turn) ? payload.turn : null;
          const completedTurnId = turn && typeof turn.id === 'string' ? turn.id : '';
          if (activeTurnId && completedTurnId && completedTurnId !== activeTurnId) {
            return;
          }
          if (!activeTurnId && completedTurnId) {
            activeTurnId = completedTurnId;
          }

          done({
            threadId: params.threadId,
            turnId: activeTurnId || completedTurnId || '',
            status: turn && typeof turn.status === 'string' ? turn.status : 'completed',
            lastAgentMessage,
            sawContextCompaction,
            sawEnteredReviewMode,
            sawExitedReviewMode,
          });
        }
      });
    });
  }

  subscribeNotifications(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async request<T>(method: string, params?: unknown): Promise<T> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new CodexAppServerError('Codex app-server is not running.');
    }

    const id = this.nextId++;
    const payload: JsonRpcRequest = { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new CodexAppServerError(
          `Failed to write Codex app-server request "${method}": ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    const payload: JsonRpcRequest = { method, params };
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // ignore notify failures
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (typeof message.method === 'string') {
      for (const listener of this.listeners) {
        listener({ method: message.method, params: message.params });
      }
    }

    if (message.id === undefined) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new CodexAppServerError(
        `Codex app-server ${pending.method} failed: ${message.error.message || 'Unknown error'}`,
      ));
      return;
    }

    pending.resolve(message.result);
  }

  private failAllPending(error: Error): void {
    if (this.closed) return;
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAccount(value: unknown): value is CodexAppServerAccount {
  return isRecord(value) && typeof value.type === 'string';
}

export async function withCodexAppServer<T>(
  fn: (client: CodexAppServerClient) => Promise<T>,
  options: { requestTimeoutMs?: number; codexPathOverride?: string } = {},
): Promise<T> {
  const session = new CodexAppServerSession(options.requestTimeoutMs ?? 5000, options.codexPathOverride);
  await session.start();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
