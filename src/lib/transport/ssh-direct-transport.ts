/**
 * SSH Direct Transport Implementation
 *
 * Executes commands directly on the remote host via SSH.
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { randomUUID } from 'crypto';
import type { RemoteConnection } from '@/types';
import {
  runRemoteCommand,
  buildSshProcessArgs,
  quoteShellArg,
  shellJoin,
} from '@/lib/remote-ssh';
import { markRemoteConnectionSuccess, markRemoteConnectionError } from '@/lib/remote-connections';
import {
  startHealthMonitor,
  stopHealthMonitor,
  disposeHealthMonitor,
  getHealthMonitorState,
  subscribeHealthMonitor,
  checkConnectionHealth,
} from '@/lib/remote-health-monitor';
import type {
  RuntimeTransport,
  SSHDirectTransportConfig,
  TransportState,
  TransportStatus,
  TransportHealthResult,
  TransportEvent,
  TransportEventListener,
  ExecuteOptions,
  ExecuteResult,
  SpawnTransportOptions,
  FileInfo,
  HealthMonitorConfig,
} from './types';

export class SSHDirectTransport implements RuntimeTransport {
  readonly id: string;
  readonly mode = 'ssh_direct' as const;
  readonly config: SSHDirectTransportConfig;

  private _status: TransportStatus = 'disconnected';
  private _error: string | null = null;
  private _lastConnectedAt: string | null = null;
  private _lastDisconnectedAt: string | null = null;
  private _listeners: Set<TransportEventListener> = new Set();
  private _healthUnsubscribe: (() => void) | null = null;
  private _disposed = false;
  private _activeProcesses: Set<ChildProcess> = new Set();

  constructor(config: SSHDirectTransportConfig) {
    this.id = `ssh-direct-${randomUUID().slice(0, 8)}`;
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Connection Lifecycle
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this._disposed) throw new Error('Transport has been disposed');
    if (this._status === 'connected') return;

    const prev = this._status;
    this._status = 'connecting';
    this.emitStatusChange(prev, 'connecting');

    try {
      // Test SSH connectivity and verify remote path exists
      const result = await runRemoteCommand(
        this.config.connection,
        `test -d ${quoteShellArg(this.config.remotePath)} && echo __ok__`,
        { timeoutMs: 15000 },
      );

      if (!result.stdout.includes('__ok__')) {
        throw new Error(`Remote directory does not exist: ${this.config.remotePath}`);
      }

      this._status = 'connected';
      this._lastConnectedAt = new Date().toISOString();
      this._error = null;
      markRemoteConnectionSuccess(this.config.connection.id);
      this.emitStatusChange('connecting', 'connected');
    } catch (err) {
      this._status = 'error';
      this._error = err instanceof Error ? err.message : String(err);
      markRemoteConnectionError(this.config.connection.id, this._error);
      this.emitStatusChange('connecting', 'error');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this._status === 'disconnected') return;

    const prev = this._status;
    this.stopHealthMonitor();

    for (const proc of this._activeProcesses) {
      try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    }
    this._activeProcesses.clear();

    this._status = 'disconnected';
    this._lastDisconnectedAt = new Date().toISOString();
    this.emitStatusChange(prev, 'disconnected');
  }

  isConnected(): boolean {
    return this._status === 'connected';
  }

  getState(): TransportState {
    const healthState = getHealthMonitorState(this.config.connection.id);
    return {
      status: this._status,
      health: healthState?.health ?? null,
      reconnectAttempts: healthState?.reconnectAttempts ?? 0,
      lastConnectedAt: this._lastConnectedAt,
      lastDisconnectedAt: this._lastDisconnectedAt,
      error: this._error,
    };
  }

  // ---------------------------------------------------------------------------
  // Health Monitoring (delegates to remote-health-monitor)
  // ---------------------------------------------------------------------------

  async checkHealth(): Promise<TransportHealthResult> {
    return checkConnectionHealth(this.config.connection.id);
  }

  startHealthMonitor(config?: Partial<HealthMonitorConfig>): void {
    if (!this._healthUnsubscribe) {
      this._healthUnsubscribe = subscribeHealthMonitor(
        this.config.connection.id,
        (event) => {
          if (event.type === 'status_changed') {
            const newStatus = event.data.currentStatus;
            if (newStatus && newStatus !== this._status) {
              const prev = this._status;
              this._status = newStatus;
              this._error = event.data.error ?? null;
              this.emitStatusChange(prev, newStatus);
            }
          }
          for (const listener of this._listeners) {
            try { listener(event); } catch { /* ignore */ }
          }
        },
      );
    }

    startHealthMonitor(this.config.connection.id, config);
  }

  stopHealthMonitor(): void {
    stopHealthMonitor(this.config.connection.id);
    if (this._healthUnsubscribe) {
      this._healthUnsubscribe();
      this._healthUnsubscribe = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Command Execution (remote via SSH, no local mirror)
  // ---------------------------------------------------------------------------

  async execute(command: string[], options?: ExecuteOptions): Promise<ExecuteResult> {
    if (!this.isConnected()) throw new Error('Transport is not connected');
    if (command.length === 0) throw new Error('Command array cannot be empty');

    const startTime = Date.now();
    const cwd = options?.cwd ?? this.config.remotePath;
    const envExports = options?.env
      ? Object.entries(options.env)
          .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
          .map(([k, v]) => `export ${k}=${quoteShellArg(v)};`)
          .join(' ')
      : '';

    const fullCommand = `cd ${quoteShellArg(cwd)} && ${envExports} ${shellJoin(command)}`.trim();

    try {
      const result = await runRemoteCommand(
        this.config.connection,
        fullCommand,
        { timeoutMs: options?.timeoutMs ?? 120000 },
      );

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        exitCode: 1,
        stdout: '',
        stderr: errMsg,
        timedOut: errMsg.includes('ETIMEDOUT') || errMsg.includes('timeout'),
        durationMs,
      };
    }
  }

  spawn(command: string[], options?: SpawnTransportOptions): ChildProcess {
    if (!this.isConnected()) throw new Error('Transport is not connected');
    if (command.length === 0) throw new Error('Command array cannot be empty');

    const cwd = options?.cwd ?? this.config.remotePath;
    const envExports = options?.env
      ? Object.entries(options.env)
          .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
          .map(([k, v]) => `export ${k}=${quoteShellArg(v)};`)
          .join(' ')
      : '';

    const shellScript = `cd ${quoteShellArg(cwd)} && ${envExports} ${shellJoin(command)}`.trim();
    const sshArgs = buildSshProcessArgs(
      this.config.connection,
      ['sh', '-lc', shellScript],
      { batchMode: false },
    );

    const proc = spawn('ssh', sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options?.signal,
    });

    this._activeProcesses.add(proc);
    proc.on('exit', () => this._activeProcesses.delete(proc));
    proc.on('error', () => this._activeProcesses.delete(proc));

    return proc;
  }

  // ---------------------------------------------------------------------------
  // File Operations (remote, no local mirror)
  // ---------------------------------------------------------------------------

  getWorkingDirectory(): string {
    return this.config.remotePath;
  }

  resolvePath(relativePath: string): string {
    const resolved = path.posix.isAbsolute(relativePath)
      ? relativePath
      : path.posix.normalize(path.posix.join(this.config.remotePath, relativePath));
    // Ensure resolved path stays within the workspace root
    const root = this.config.remotePath.endsWith('/') ? this.config.remotePath : this.config.remotePath + '/';
    if (resolved !== this.config.remotePath && !resolved.startsWith(root)) {
      throw new Error(`Path traversal blocked: ${relativePath}`);
    }
    return resolved;
  }

  async readFile(filePath: string): Promise<string> {
    const absPath = this.resolvePath(filePath);
    const result = await runRemoteCommand(
      this.config.connection,
      `cat ${quoteShellArg(absPath)}`,
      { timeoutMs: 30000 },
    );
    return result.stdout;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const absPath = this.resolvePath(filePath);
    const dir = path.posix.dirname(absPath);
    // Use heredoc to write content safely
    const escapedContent = content.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
    await runRemoteCommand(
      this.config.connection,
      `mkdir -p ${quoteShellArg(dir)} && printf '%s' ${quoteShellArg(escapedContent)} > ${quoteShellArg(absPath)}`,
      { timeoutMs: 30000 },
    );
  }

  async listDirectory(dirPath: string): Promise<FileInfo[]> {
    const absPath = this.resolvePath(dirPath);
    const result = await runRemoteCommand(
      this.config.connection,
      `ls -la --time-style=full-iso ${quoteShellArg(absPath)} 2>/dev/null || ls -la ${quoteShellArg(absPath)}`,
      { timeoutMs: 15000 },
    );

    const lines = result.stdout.split('\n').filter((l) => l.trim() && !l.startsWith('total'));
    return lines.map((line) => {
      const parts = line.split(/\s+/);
      const isDir = line.startsWith('d');
      const name = parts[parts.length - 1];
      return {
        path: path.posix.join(absPath, name),
        name,
        isDirectory: isDir,
        size: parseInt(parts[4] || '0', 10) || 0,
        modifiedAt: new Date().toISOString(),
      };
    }).filter((f) => f.name !== '.' && f.name !== '..');
  }

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  on(listener: TransportEventListener): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  emit(event: Omit<TransportEvent, 'timestamp' | 'transportId'>): void {
    const fullEvent: TransportEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      transportId: this.id,
    };
    for (const listener of this._listeners) {
      try { listener(fullEvent); } catch { /* ignore */ }
    }
  }

  private emitStatusChange(prev: TransportStatus, curr: TransportStatus): void {
    this.emit({
      type: 'status_changed',
      data: { previousStatus: prev, currentStatus: curr, error: this._error ?? undefined },
    });
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stopHealthMonitor();
    disposeHealthMonitor(this.config.connection.id);

    for (const proc of this._activeProcesses) {
      try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    }
    this._activeProcesses.clear();
    this._listeners.clear();

    if (this._status !== 'disconnected') {
      this._status = 'disconnected';
      this._lastDisconnectedAt = new Date().toISOString();
    }
  }
}

/**
 * Create an SSHDirectTransport from a RemoteConnection
 */
export function createSSHDirectTransport(
  connection: RemoteConnection,
  remotePath: string,
): SSHDirectTransport {
  return new SSHDirectTransport({
    mode: 'ssh_direct',
    connection,
    remotePath,
  });
}
