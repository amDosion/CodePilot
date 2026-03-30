/**
 * Runtime Transport Abstraction Layer
 *
 * Provides a unified interface for executing commands and managing connections
 * across different execution environments (local, SSH direct).
 */

import type { ChildProcess, SpawnOptions } from 'child_process';
import type { RemoteConnection } from '@/types';

// ============================================================================
// Transport Types
// ============================================================================

/**
 * Available transport modes for remote execution
 */
export type TransportMode = 'local' | 'ssh_direct';

/**
 * Transport connection status
 */
export type TransportStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'checking'
  | 'reconnecting'
  | 'error';

/**
 * Health check result
 */
export interface TransportHealthResult {
  healthy: boolean;
  latencyMs: number | null;
  lastCheckAt: string;
  error: string | null;
  consecutiveFailures: number;
}

/**
 * Transport state including health information
 */
export interface TransportState {
  status: TransportStatus;
  health: TransportHealthResult | null;
  reconnectAttempts: number;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  error: string | null;
}

// ============================================================================
// Transport Configuration
// ============================================================================

/**
 * Base transport configuration
 */
export interface TransportConfigBase {
  mode: TransportMode;
}

/**
 * Local transport configuration
 */
export interface LocalTransportConfig extends TransportConfigBase {
  mode: 'local';
  workingDirectory: string;
}

/**
 * SSH direct transport configuration
 */
export interface SSHDirectTransportConfig extends TransportConfigBase {
  mode: 'ssh_direct';
  connection: RemoteConnection;
  remotePath: string;
}

/**
 * Union type for all transport configurations
 */
export type TransportConfig =
  | LocalTransportConfig
  | SSHDirectTransportConfig;

// ============================================================================
// Health Monitor Configuration
// ============================================================================

/**
 * Configuration for connection health monitoring
 */
export interface HealthMonitorConfig {
  /** Interval between health checks in milliseconds (default: 30000) */
  heartbeatIntervalMs: number;
  /** Timeout for individual health check in milliseconds (default: 10000) */
  healthCheckTimeoutMs: number;
  /** Number of consecutive failures before marking disconnected (default: 3) */
  maxConsecutiveFailures: number;
  /** Enable automatic reconnection (default: true) */
  autoReconnect: boolean;
  /** Maximum reconnection attempts (default: 5) */
  maxReconnectAttempts: number;
  /** Initial delay before first reconnect attempt in ms (default: 1000) */
  reconnectInitialDelayMs: number;
  /** Maximum delay between reconnect attempts in ms (default: 30000) */
  reconnectMaxDelayMs: number;
  /** Backoff factor for reconnect delay (default: 2) */
  reconnectBackoffFactor: number;
}

/**
 * Default health monitor configuration
 */
export const DEFAULT_HEALTH_MONITOR_CONFIG: HealthMonitorConfig = {
  heartbeatIntervalMs: 30000,
  healthCheckTimeoutMs: 10000,
  maxConsecutiveFailures: 3,
  autoReconnect: true,
  maxReconnectAttempts: 5,
  reconnectInitialDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
  reconnectBackoffFactor: 2,
};

// ============================================================================
// Transport Events
// ============================================================================

/**
 * Transport event types
 */
export type TransportEventType =
  | 'status_changed'
  | 'health_check_started'
  | 'health_check_completed'
  | 'reconnect_started'
  | 'reconnect_succeeded'
  | 'reconnect_failed'
  | 'reconnect_gave_up'
  | 'error';

/**
 * Transport event payload
 */
export interface TransportEvent {
  type: TransportEventType;
  timestamp: string;
  transportId: string;
  data: {
    previousStatus?: TransportStatus;
    currentStatus?: TransportStatus;
    health?: TransportHealthResult;
    attempt?: number;
    maxAttempts?: number;
    error?: string;
    nextRetryMs?: number;
  };
}

/**
 * Transport event listener
 */
export type TransportEventListener = (event: TransportEvent) => void;

// ============================================================================
// Command Execution Options
// ============================================================================

/**
 * Options for executing a command
 */
export interface ExecuteOptions {
  /** Working directory for command execution */
  cwd?: string;
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Timeout in milliseconds (0 = no timeout) */
  timeoutMs?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Options for spawning a process
 */
export interface SpawnTransportOptions extends Omit<SpawnOptions, 'env'> {
  /** Working directory for process */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Result of command execution
 */
export interface ExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// ============================================================================
// File Operations (for transports that support them)
// ============================================================================

/**
 * File information
 */
export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

/**
 * Options for file synchronization
 */
export interface SyncOptions {
  /** Direction of sync */
  direction: 'push' | 'pull';
  /** Delete files that don't exist in source */
  delete?: boolean;
  /** Exclude patterns */
  exclude?: string[];
  /** Only sync if newer */
  update?: boolean;
}

// ============================================================================
// Runtime Transport Interface
// ============================================================================

/**
 * Core interface for runtime transport implementations
 */
export interface RuntimeTransport {
  /** Unique identifier for this transport instance */
  readonly id: string;

  /** Transport mode */
  readonly mode: TransportMode;

  /** Current transport configuration */
  readonly config: TransportConfig;

  // ---------------------------------------------------------------------------
  // Connection Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Connect the transport (initialize resources)
   */
  connect(): Promise<void>;

  /**
   * Disconnect the transport (cleanup resources)
   */
  disconnect(): Promise<void>;

  /**
   * Check if transport is currently connected and healthy
   */
  isConnected(): boolean;

  /**
   * Get current transport state
   */
  getState(): TransportState;

  // ---------------------------------------------------------------------------
  // Health Monitoring
  // ---------------------------------------------------------------------------

  /**
   * Perform a health check
   */
  checkHealth(): Promise<TransportHealthResult>;

  /**
   * Start continuous health monitoring
   */
  startHealthMonitor(config?: Partial<HealthMonitorConfig>): void;

  /**
   * Stop health monitoring
   */
  stopHealthMonitor(): void;

  // ---------------------------------------------------------------------------
  // Command Execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a command and wait for completion
   */
  execute(command: string[], options?: ExecuteOptions): Promise<ExecuteResult>;

  /**
   * Spawn a process with streaming I/O
   */
  spawn(command: string[], options?: SpawnTransportOptions): ChildProcess;

  // ---------------------------------------------------------------------------
  // File Operations (optional, may throw if not supported)
  // ---------------------------------------------------------------------------

  /**
   * Get effective working directory path
   */
  getWorkingDirectory(): string;

  /**
   * Resolve a path relative to working directory
   */
  resolvePath(relativePath: string): string;

  /**
   * Read file contents
   * @throws Error if not supported
   */
  readFile?(path: string): Promise<string>;

  /**
   * Write file contents
   * @throws Error if not supported
   */
  writeFile?(path: string, content: string): Promise<void>;

  /**
   * List directory contents
   * @throws Error if not supported
   */
  listDirectory?(path: string): Promise<FileInfo[]>;

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to transport events
   */
  on(listener: TransportEventListener): () => void;

  /**
   * Emit a transport event
   */
  emit(event: Omit<TransportEvent, 'timestamp' | 'transportId'>): void;

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Dispose of transport resources
   */
  dispose(): void;
}

// ============================================================================
// Transport Factory Types
// ============================================================================

/**
 * Options for creating a transport
 */
export interface CreateTransportOptions {
  /** Transport configuration */
  config: TransportConfig;
  /** Health monitor configuration override */
  healthConfig?: Partial<HealthMonitorConfig>;
  /** Auto-connect on creation */
  autoConnect?: boolean;
}

/**
 * Transport factory function signature
 */
export type TransportFactory = (options: CreateTransportOptions) => RuntimeTransport;

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Extract config type for a specific transport mode
 */
export type ConfigForMode<T extends TransportMode> = Extract<TransportConfig, { mode: T }>;

/**
 * Check if config is for a specific mode
 */
export function isLocalConfig(config: TransportConfig): config is LocalTransportConfig {
  return config.mode === 'local';
}

export function isSSHDirectConfig(config: TransportConfig): config is SSHDirectTransportConfig {
  return config.mode === 'ssh_direct';
}
