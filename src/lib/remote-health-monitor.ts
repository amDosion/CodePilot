/**
 * SSH Connection Health Monitor
 *
 * Session-level SSH connection health checking with:
 * - Heartbeat mechanism using lightweight SSH commands
 * - Connection state machine (connected -> checking -> connected/disconnected)
 * - Event emitter pattern for health state changes
 * - Integration with remote-connections for status updates
 * - Configurable timeout, retry count, and auto-reconnect with exponential backoff
 */

import type { RemoteConnection } from '@/types';
import type {
  TransportStatus,
  TransportHealthResult,
  TransportState,
  TransportEvent,
  TransportEventType,
  TransportEventListener,
  HealthMonitorConfig,
} from '@/lib/transport/types';
import { DEFAULT_HEALTH_MONITOR_CONFIG } from '@/lib/transport/types';
import { runRemoteCommand } from '@/lib/remote-ssh';
import { markRemoteConnectionSuccess, markRemoteConnectionError, getRemoteConnection } from '@/lib/remote-connections';

// ============================================================================
// Types
// ============================================================================

/**
 * Health monitor entry for a single connection
 */
interface HealthMonitorEntry {
  connectionId: string;
  state: TransportState;
  config: HealthMonitorConfig;
  listeners: Set<TransportEventListener>;
  heartbeatTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  isChecking: boolean;
  gcTimer: NodeJS.Timeout | null;
}

// ============================================================================
// Constants
// ============================================================================

const GLOBAL_KEY = '__codepilot_remote_health_monitor__' as const;
const HEARTBEAT_COMMAND = 'echo __heartbeat__ && exit 0';
const HEARTBEAT_MARKER = '__heartbeat__';
const GC_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// Singleton Management
// ============================================================================

function getEntries(): Map<string, HealthMonitorEntry> {
  if (!(globalThis as Record<string, unknown>)[GLOBAL_KEY]) {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = new Map<string, HealthMonitorEntry>();
  }
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, HealthMonitorEntry>;
}

// ============================================================================
// Utility Functions
// ============================================================================

function nowIso(): string {
  return new Date().toISOString();
}

function createInitialState(): TransportState {
  return {
    status: 'disconnected',
    health: null,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    error: null,
  };
}

function createHealthResult(
  healthy: boolean,
  latencyMs: number | null,
  error: string | null,
  consecutiveFailures: number,
): TransportHealthResult {
  return {
    healthy,
    latencyMs,
    lastCheckAt: nowIso(),
    error,
    consecutiveFailures,
  };
}

function cloneState(state: TransportState): TransportState {
  return {
    ...state,
    health: state.health ? { ...state.health } : null,
  };
}

// ============================================================================
// Entry Management
// ============================================================================

function ensureEntry(connectionId: string, config?: Partial<HealthMonitorConfig>): HealthMonitorEntry {
  const entries = getEntries();
  let entry = entries.get(connectionId);
  if (!entry) {
    entry = {
      connectionId,
      state: createInitialState(),
      config: { ...DEFAULT_HEALTH_MONITOR_CONFIG, ...config },
      listeners: new Set(),
      heartbeatTimer: null,
      reconnectTimer: null,
      isChecking: false,
      gcTimer: null,
    };
    entries.set(connectionId, entry);
  } else if (config) {
    entry.config = { ...entry.config, ...config };
  }
  return entry;
}

function clearGc(entry: HealthMonitorEntry): void {
  if (!entry.gcTimer) return;
  clearTimeout(entry.gcTimer);
  entry.gcTimer = null;
}

function scheduleGc(entry: HealthMonitorEntry): void {
  clearGc(entry);
  if (entry.heartbeatTimer || entry.reconnectTimer || entry.listeners.size > 0) return;
  entry.gcTimer = setTimeout(() => {
    const current = getEntries().get(entry.connectionId);
    if (!current) return;
    if (current.heartbeatTimer || current.reconnectTimer || current.listeners.size > 0) return;
    getEntries().delete(entry.connectionId);
  }, GC_MS);
  entry.gcTimer.unref?.();
}

// ============================================================================
// Event Emission
// ============================================================================

function emitEvent(entry: HealthMonitorEntry, type: TransportEventType, data: TransportEvent['data']): void {
  const event: TransportEvent = {
    type,
    timestamp: nowIso(),
    transportId: entry.connectionId,
    data,
  };
  for (const listener of entry.listeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[remote-health-monitor] listener error:', error);
    }
  }
}

function updateStatus(entry: HealthMonitorEntry, newStatus: TransportStatus, error?: string): void {
  const previousStatus = entry.state.status;
  if (previousStatus === newStatus && entry.state.error === (error ?? null)) return;

  entry.state.status = newStatus;
  entry.state.error = error ?? null;

  if (newStatus === 'connected' && previousStatus !== 'connected') {
    entry.state.lastConnectedAt = nowIso();
    entry.state.reconnectAttempts = 0;
  } else if (newStatus === 'disconnected' && previousStatus !== 'disconnected') {
    entry.state.lastDisconnectedAt = nowIso();
  }

  emitEvent(entry, 'status_changed', {
    previousStatus,
    currentStatus: newStatus,
    error,
  });
}

// ============================================================================
// Health Check Logic
// ============================================================================

async function performHealthCheck(entry: HealthMonitorEntry): Promise<TransportHealthResult> {
  const connection = getRemoteConnection(entry.connectionId);
  if (!connection) {
    const result = createHealthResult(false, null, 'Connection not found', (entry.state.health?.consecutiveFailures ?? 0) + 1);
    entry.state.health = result;
    return result;
  }

  const startTime = Date.now();
  entry.isChecking = true;
  updateStatus(entry, 'checking');
  emitEvent(entry, 'health_check_started', {});

  try {
    const commandResult = await runRemoteCommand(connection, HEARTBEAT_COMMAND, {
      timeoutMs: entry.config.healthCheckTimeoutMs,
    });

    const latencyMs = Date.now() - startTime;

    if (commandResult.stdout.includes(HEARTBEAT_MARKER)) {
      const result = createHealthResult(true, latencyMs, null, 0);
      entry.state.health = result;
      entry.isChecking = false;
      updateStatus(entry, 'connected');
      markRemoteConnectionSuccess(connection.id);
      emitEvent(entry, 'health_check_completed', { health: result });
      return result;
    } else {
      const errorMsg = 'Heartbeat marker not found in response';
      const consecutiveFailures = (entry.state.health?.consecutiveFailures ?? 0) + 1;
      const result = createHealthResult(false, latencyMs, errorMsg, consecutiveFailures);
      entry.state.health = result;
      entry.isChecking = false;
      handleHealthCheckFailure(entry, connection, errorMsg, consecutiveFailures);
      emitEvent(entry, 'health_check_completed', { health: result });
      return result;
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    const consecutiveFailures = (entry.state.health?.consecutiveFailures ?? 0) + 1;
    const result = createHealthResult(false, latencyMs, errorMsg, consecutiveFailures);
    entry.state.health = result;
    entry.isChecking = false;
    handleHealthCheckFailure(entry, connection, errorMsg, consecutiveFailures);
    emitEvent(entry, 'health_check_completed', { health: result });
    return result;
  }
}

function handleHealthCheckFailure(
  entry: HealthMonitorEntry,
  connection: RemoteConnection,
  error: string,
  consecutiveFailures: number,
): void {
  if (consecutiveFailures >= entry.config.maxConsecutiveFailures) {
    updateStatus(entry, 'disconnected', error);
    markRemoteConnectionError(connection.id, error);

    if (entry.config.autoReconnect) {
      scheduleReconnect(entry);
    }
  } else {
    // Still considered connected, just had a failed check
    updateStatus(entry, 'connected', error);
  }
}

// ============================================================================
// Reconnection Logic
// ============================================================================

function calculateBackoffDelay(entry: HealthMonitorEntry): number {
  const { reconnectInitialDelayMs, reconnectMaxDelayMs, reconnectBackoffFactor } = entry.config;
  const delay = reconnectInitialDelayMs * Math.pow(reconnectBackoffFactor, entry.state.reconnectAttempts);
  return Math.min(delay, reconnectMaxDelayMs);
}

function scheduleReconnect(entry: HealthMonitorEntry): void {
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  if (entry.state.reconnectAttempts >= entry.config.maxReconnectAttempts) {
    emitEvent(entry, 'reconnect_gave_up', {
      attempt: entry.state.reconnectAttempts,
      maxAttempts: entry.config.maxReconnectAttempts,
    });
    return;
  }

  const delay = calculateBackoffDelay(entry);
  entry.state.reconnectAttempts++;

  emitEvent(entry, 'reconnect_started', {
    attempt: entry.state.reconnectAttempts,
    maxAttempts: entry.config.maxReconnectAttempts,
    nextRetryMs: delay,
  });

  updateStatus(entry, 'reconnecting');

  entry.reconnectTimer = setTimeout(async () => {
    entry.reconnectTimer = null;
    await attemptReconnect(entry);
  }, delay);
  entry.reconnectTimer.unref?.();
}

async function attemptReconnect(entry: HealthMonitorEntry): Promise<void> {
  const result = await performHealthCheck(entry);

  if (result.healthy) {
    emitEvent(entry, 'reconnect_succeeded', {
      attempt: entry.state.reconnectAttempts,
      maxAttempts: entry.config.maxReconnectAttempts,
    });
    // Restart heartbeat monitoring
    startHeartbeat(entry);
  } else {
    emitEvent(entry, 'reconnect_failed', {
      attempt: entry.state.reconnectAttempts,
      maxAttempts: entry.config.maxReconnectAttempts,
      error: result.error ?? 'Unknown error',
    });

    if (entry.state.reconnectAttempts < entry.config.maxReconnectAttempts) {
      scheduleReconnect(entry);
    } else {
      emitEvent(entry, 'reconnect_gave_up', {
        attempt: entry.state.reconnectAttempts,
        maxAttempts: entry.config.maxReconnectAttempts,
      });
    }
  }
}

// ============================================================================
// Heartbeat Management
// ============================================================================

function startHeartbeat(entry: HealthMonitorEntry): void {
  stopHeartbeat(entry);

  const tick = async () => {
    if (!entry.heartbeatTimer) return; // Monitor was stopped
    await performHealthCheck(entry);

    // Schedule next heartbeat if still monitoring and connected
    if (entry.heartbeatTimer && entry.state.status !== 'disconnected') {
      entry.heartbeatTimer = setTimeout(tick, entry.config.heartbeatIntervalMs);
      entry.heartbeatTimer.unref?.();
    }
  };

  // Run first check immediately, then schedule subsequent checks
  entry.heartbeatTimer = setTimeout(tick, 0);
  entry.heartbeatTimer.unref?.();
}

function stopHeartbeat(entry: HealthMonitorEntry): void {
  if (entry.heartbeatTimer) {
    clearTimeout(entry.heartbeatTimer);
    entry.heartbeatTimer = null;
  }
}

function stopReconnect(entry: HealthMonitorEntry): void {
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get the current health state for a connection
 */
export function getHealthMonitorState(connectionId: string): TransportState {
  const entry = getEntries().get(connectionId);
  if (!entry) {
    return createInitialState();
  }
  return cloneState(entry.state);
}

/**
 * Subscribe to health monitor events for a connection
 */
export function subscribeHealthMonitor(
  connectionId: string,
  listener: TransportEventListener,
): () => void {
  const entry = ensureEntry(connectionId);
  clearGc(entry);
  entry.listeners.add(listener);

  return () => {
    entry.listeners.delete(listener);
    scheduleGc(entry);
  };
}

/**
 * Perform a single health check for a connection
 */
export async function checkConnectionHealth(
  connectionId: string,
  config?: Partial<HealthMonitorConfig>,
): Promise<TransportHealthResult> {
  const entry = ensureEntry(connectionId, config);
  clearGc(entry);

  try {
    return await performHealthCheck(entry);
  } finally {
    scheduleGc(entry);
  }
}

/**
 * Start continuous health monitoring for a connection
 */
export function startHealthMonitor(
  connectionId: string,
  config?: Partial<HealthMonitorConfig>,
): void {
  const entry = ensureEntry(connectionId, config);
  clearGc(entry);

  // Mark as connected initially (assuming the connection was established)
  if (entry.state.status === 'disconnected') {
    updateStatus(entry, 'connected');
  }

  startHeartbeat(entry);
}

/**
 * Stop health monitoring for a connection
 */
export function stopHealthMonitor(connectionId: string): void {
  const entry = getEntries().get(connectionId);
  if (!entry) return;

  stopHeartbeat(entry);
  stopReconnect(entry);
  scheduleGc(entry);
}

/**
 * Manually trigger reconnection for a connection
 */
export function triggerReconnect(connectionId: string): void {
  const entry = getEntries().get(connectionId);
  if (!entry) return;

  // Reset reconnect attempts to allow fresh reconnect
  entry.state.reconnectAttempts = 0;
  scheduleReconnect(entry);
}

/**
 * Update health monitor configuration for a connection
 */
export function updateHealthMonitorConfig(
  connectionId: string,
  config: Partial<HealthMonitorConfig>,
): void {
  const entry = getEntries().get(connectionId);
  if (!entry) return;

  entry.config = { ...entry.config, ...config };

  // Restart heartbeat if running to apply new interval
  if (entry.heartbeatTimer) {
    startHeartbeat(entry);
  }
}

/**
 * Check if health monitoring is active for a connection
 */
export function isHealthMonitorActive(connectionId: string): boolean {
  const entry = getEntries().get(connectionId);
  return entry?.heartbeatTimer !== null || entry?.reconnectTimer !== null;
}

/**
 * Get the configuration for a connection's health monitor
 */
export function getHealthMonitorConfig(connectionId: string): HealthMonitorConfig {
  const entry = getEntries().get(connectionId);
  return entry?.config ?? { ...DEFAULT_HEALTH_MONITOR_CONFIG };
}

/**
 * Dispose of a connection's health monitor completely
 */
export function disposeHealthMonitor(connectionId: string): void {
  const entry = getEntries().get(connectionId);
  if (!entry) return;

  stopHeartbeat(entry);
  stopReconnect(entry);
  clearGc(entry);
  entry.listeners.clear();
  getEntries().delete(connectionId);
}

/**
 * Dispose of all health monitors
 */
export function disposeAllHealthMonitors(): void {
  const entries = getEntries();
  for (const [connectionId] of entries) {
    disposeHealthMonitor(connectionId);
  }
}
