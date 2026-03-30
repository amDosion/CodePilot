/**
 * Local Transport Implementation
 *
 * Provides command execution and file operations for local environment.
 * Implements RuntimeTransport interface for consistent API across all transport modes.
 */

import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  RuntimeTransport,
  LocalTransportConfig,
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

const execFileAsync = promisify(execFile);

// ============================================================================
// Local Transport Implementation
// ============================================================================

export class LocalTransport implements RuntimeTransport {
  readonly id: string;
  readonly mode = 'local' as const;
  readonly config: LocalTransportConfig;

  private _status: TransportStatus = 'disconnected';
  private _health: TransportHealthResult | null = null;
  private _lastConnectedAt: string | null = null;
  private _lastDisconnectedAt: string | null = null;
  private _error: string | null = null;
  private _reconnectAttempts = 0;

  private _listeners: Set<TransportEventListener> = new Set();
  private _healthMonitorInterval: NodeJS.Timeout | null = null;
  private _healthMonitorConfig: HealthMonitorConfig | null = null;
  private _disposed = false;
  private _activeProcesses: Set<ChildProcess> = new Set();

  constructor(config: LocalTransportConfig) {
    this.id = `local-${randomUUID().slice(0, 8)}`;
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Connection Lifecycle
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this._disposed) {
      throw new Error('Transport has been disposed');
    }

    if (this._status === 'connected') {
      return;
    }

    const previousStatus = this._status;
    this._status = 'connecting';
    this.emitStatusChange(previousStatus, this._status);

    try {
      // Verify working directory exists
      const stats = await fs.stat(this.config.workingDirectory);
      if (!stats.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${this.config.workingDirectory}`);
      }

      this._status = 'connected';
      this._lastConnectedAt = new Date().toISOString();
      this._error = null;
      this._reconnectAttempts = 0;
      this.emitStatusChange('connecting', this._status);
    } catch (err) {
      this._status = 'error';
      this._error = err instanceof Error ? err.message : 'Unknown connection error';
      this.emitStatusChange('connecting', this._status);
      this.emit({
        type: 'error',
        data: { error: this._error },
      });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this._status === 'disconnected') {
      return;
    }

    const previousStatus = this._status;

    // Stop health monitoring
    this.stopHealthMonitor();

    // Terminate all active processes
    for (const proc of this._activeProcesses) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may have already exited
      }
    }
    this._activeProcesses.clear();

    this._status = 'disconnected';
    this._lastDisconnectedAt = new Date().toISOString();
    this.emitStatusChange(previousStatus, this._status);
  }

  isConnected(): boolean {
    return this._status === 'connected';
  }

  getState(): TransportState {
    return {
      status: this._status,
      health: this._health,
      reconnectAttempts: this._reconnectAttempts,
      lastConnectedAt: this._lastConnectedAt,
      lastDisconnectedAt: this._lastDisconnectedAt,
      error: this._error,
    };
  }

  // ---------------------------------------------------------------------------
  // Health Monitoring
  // ---------------------------------------------------------------------------

  async checkHealth(): Promise<TransportHealthResult> {
    const startTime = Date.now();

    this.emit({
      type: 'health_check_started',
      data: {},
    });

    try {
      // For local transport, health check is simple: verify working directory exists
      const stats = await fs.stat(this.config.workingDirectory);

      if (!stats.isDirectory()) {
        throw new Error('Working directory is not a directory');
      }

      const latencyMs = Date.now() - startTime;
      const result: TransportHealthResult = {
        healthy: true,
        latencyMs,
        lastCheckAt: new Date().toISOString(),
        error: null,
        consecutiveFailures: 0,
      };

      this._health = result;
      this.emit({
        type: 'health_check_completed',
        data: { health: result },
      });

      return result;
    } catch (err) {
      const consecutiveFailures = (this._health?.consecutiveFailures ?? 0) + 1;
      const result: TransportHealthResult = {
        healthy: false,
        latencyMs: null,
        lastCheckAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : 'Unknown health check error',
        consecutiveFailures,
      };

      this._health = result;
      this.emit({
        type: 'health_check_completed',
        data: { health: result },
      });

      return result;
    }
  }

  startHealthMonitor(config?: Partial<HealthMonitorConfig>): void {
    if (this._healthMonitorInterval) {
      this.stopHealthMonitor();
    }

    const defaultConfig: HealthMonitorConfig = {
      heartbeatIntervalMs: 30000,
      healthCheckTimeoutMs: 10000,
      maxConsecutiveFailures: 3,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      reconnectInitialDelayMs: 1000,
      reconnectMaxDelayMs: 30000,
      reconnectBackoffFactor: 2,
    };

    this._healthMonitorConfig = { ...defaultConfig, ...config };

    this._healthMonitorInterval = setInterval(async () => {
      if (this._disposed) {
        this.stopHealthMonitor();
        return;
      }

      const health = await this.checkHealth();

      // For local transport, health issues are unlikely but handle them
      if (!health.healthy && this._healthMonitorConfig) {
        const { maxConsecutiveFailures, autoReconnect } = this._healthMonitorConfig;

        if (health.consecutiveFailures >= maxConsecutiveFailures) {
          const previousStatus = this._status;
          this._status = 'error';
          this._error = health.error;
          this.emitStatusChange(previousStatus, this._status);

          if (autoReconnect) {
            await this.attemptReconnect();
          }
        }
      }
    }, this._healthMonitorConfig.heartbeatIntervalMs);
  }

  stopHealthMonitor(): void {
    if (this._healthMonitorInterval) {
      clearInterval(this._healthMonitorInterval);
      this._healthMonitorInterval = null;
    }
    this._healthMonitorConfig = null;
  }

  private async attemptReconnect(): Promise<void> {
    if (!this._healthMonitorConfig || this._disposed) {
      return;
    }

    const { maxReconnectAttempts, reconnectInitialDelayMs, reconnectMaxDelayMs, reconnectBackoffFactor } =
      this._healthMonitorConfig;

    if (this._reconnectAttempts >= maxReconnectAttempts) {
      this.emit({
        type: 'reconnect_gave_up',
        data: {
          attempt: this._reconnectAttempts,
          maxAttempts: maxReconnectAttempts,
        },
      });
      return;
    }

    this._reconnectAttempts++;
    const delay = Math.min(
      reconnectInitialDelayMs * Math.pow(reconnectBackoffFactor, this._reconnectAttempts - 1),
      reconnectMaxDelayMs,
    );

    this.emit({
      type: 'reconnect_started',
      data: {
        attempt: this._reconnectAttempts,
        maxAttempts: maxReconnectAttempts,
        nextRetryMs: delay,
      },
    });

    const previousStatus = this._status;
    this._status = 'reconnecting';
    this.emitStatusChange(previousStatus, this._status);

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await this.connect();
      this.emit({
        type: 'reconnect_succeeded',
        data: { attempt: this._reconnectAttempts },
      });
    } catch (err) {
      this.emit({
        type: 'reconnect_failed',
        data: {
          attempt: this._reconnectAttempts,
          maxAttempts: maxReconnectAttempts,
          error: err instanceof Error ? err.message : 'Unknown error',
        },
      });

      // Try again if not at max attempts
      if (this._reconnectAttempts < maxReconnectAttempts) {
        await this.attemptReconnect();
      } else {
        this.emit({
          type: 'reconnect_gave_up',
          data: {
            attempt: this._reconnectAttempts,
            maxAttempts: maxReconnectAttempts,
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Command Execution
  // ---------------------------------------------------------------------------

  async execute(command: string[], options?: ExecuteOptions): Promise<ExecuteResult> {
    if (!this.isConnected()) {
      throw new Error('Transport is not connected');
    }

    if (command.length === 0) {
      throw new Error('Command array cannot be empty');
    }

    const startTime = Date.now();
    const [cmd, ...args] = command;
    const cwd = options?.cwd ? this.resolvePath(options.cwd) : this.config.workingDirectory;

    // Merge environment variables
    const env = { ...process.env, ...options?.env };

    try {
      const execOptions: { timeout?: number; cwd: string; env: typeof env; signal?: AbortSignal; maxBuffer: number } = {
        cwd,
        env,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      };

      if (options?.timeoutMs && options.timeoutMs > 0) {
        execOptions.timeout = options.timeoutMs;
      }

      if (options?.signal) {
        execOptions.signal = options.signal;
      }

      const { stdout, stderr } = await execFileAsync(cmd, args, execOptions);
      const durationMs = Date.now() - startTime;

      return {
        exitCode: 0,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut: false,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const err = error as NodeJS.ErrnoException & {
        stdout?: Buffer | string;
        stderr?: Buffer | string;
        code?: number | string;
        killed?: boolean;
        signal?: string;
      };

      const timedOut = err.signal === 'SIGTERM' && err.killed === true;
      const exitCode = typeof err.code === 'number' ? err.code : 1;

      return {
        exitCode,
        stdout: err.stdout?.toString() ?? '',
        stderr: err.stderr?.toString() ?? err.message ?? '',
        timedOut,
        durationMs,
      };
    }
  }

  spawn(command: string[], options?: SpawnTransportOptions): ChildProcess {
    if (!this.isConnected()) {
      throw new Error('Transport is not connected');
    }

    if (command.length === 0) {
      throw new Error('Command array cannot be empty');
    }

    const [cmd, ...args] = command;
    const cwd = options?.cwd ? this.resolvePath(options.cwd) : this.config.workingDirectory;

    // Merge environment variables
    const env = { ...process.env, ...options?.env } as NodeJS.ProcessEnv;

    const spawnOptions: SpawnOptions = {
      ...options,
      cwd,
      env,
    };

    const proc = spawn(cmd, args, spawnOptions);

    // Track active processes for cleanup
    this._activeProcesses.add(proc);
    proc.on('exit', () => {
      this._activeProcesses.delete(proc);
    });
    proc.on('error', () => {
      this._activeProcesses.delete(proc);
    });

    // Handle abort signal
    if (options?.signal) {
      options.signal.addEventListener(
        'abort',
        () => {
          if (!proc.killed) {
            proc.kill('SIGTERM');
          }
        },
        { once: true },
      );
    }

    return proc;
  }

  // ---------------------------------------------------------------------------
  // File Operations
  // ---------------------------------------------------------------------------

  getWorkingDirectory(): string {
    return this.config.workingDirectory;
  }

  resolvePath(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      return path.normalize(relativePath);
    }
    return path.normalize(path.join(this.config.workingDirectory, relativePath));
  }

  async readFile(filePath: string): Promise<string> {
    const absolutePath = this.resolvePath(filePath);
    return fs.readFile(absolutePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const absolutePath = this.resolvePath(filePath);
    const dir = path.dirname(absolutePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf-8');
  }

  async listDirectory(dirPath: string): Promise<FileInfo[]> {
    const absolutePath = this.resolvePath(dirPath);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });

    const fileInfos: FileInfo[] = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(absolutePath, entry.name);
        try {
          const stats = await fs.stat(entryPath);
          return {
            path: entryPath,
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          };
        } catch {
          // Handle case where stat fails (e.g., broken symlink)
          return {
            path: entryPath,
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: 0,
            modifiedAt: new Date().toISOString(),
          };
        }
      }),
    );

    return fileInfos;
  }

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  on(listener: TransportEventListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  emit(event: Omit<TransportEvent, 'timestamp' | 'transportId'>): void {
    const fullEvent: TransportEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      transportId: this.id,
    };

    for (const listener of this._listeners) {
      try {
        listener(fullEvent);
      } catch (err) {
        console.warn(`[LocalTransport] Event listener error:`, err);
      }
    }
  }

  private emitStatusChange(previousStatus: TransportStatus, currentStatus: TransportStatus): void {
    this.emit({
      type: 'status_changed',
      data: {
        previousStatus,
        currentStatus,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    // Stop health monitoring
    this.stopHealthMonitor();

    // Terminate all active processes
    for (const proc of this._activeProcesses) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Process may have already exited
      }
    }
    this._activeProcesses.clear();

    // Clear listeners
    this._listeners.clear();

    // Update status
    if (this._status !== 'disconnected') {
      const _previousStatus = this._status;
      this._status = 'disconnected';
      this._lastDisconnectedAt = new Date().toISOString();
      // Don't emit after clearing listeners
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new LocalTransport instance
 */
export function createLocalTransport(workingDirectory: string): LocalTransport {
  return new LocalTransport({
    mode: 'local',
    workingDirectory: path.resolve(workingDirectory),
  });
}

/**
 * Create a LocalTransport from config
 */
export function createLocalTransportFromConfig(config: LocalTransportConfig): LocalTransport {
  return new LocalTransport({
    ...config,
    workingDirectory: path.resolve(config.workingDirectory),
  });
}
