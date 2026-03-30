/**
 * Transport Factory
 *
 * Creates RuntimeTransport instances based on configuration.
 * Provides transport selection logic and capability detection.
 */

import type { RemoteConnection, WorkspaceTransport } from '@/types';
import { getRemoteConnection } from '@/lib/remote-connections';
import type {
  RuntimeTransport,
  TransportConfig,
  TransportMode,
  CreateTransportOptions,
} from './types';
import { LocalTransport } from './local-transport';
import { SSHDirectTransport, createSSHDirectTransport } from './ssh-direct-transport';

/**
 * Create a transport from explicit configuration
 */
export function createTransport(options: CreateTransportOptions): RuntimeTransport {
  const { config, healthConfig, autoConnect } = options;

  let transport: RuntimeTransport;

  switch (config.mode) {
    case 'local': {
      transport = new LocalTransport(config);
      break;
    }
    case 'ssh_direct': {
      transport = new SSHDirectTransport(config);
      break;
    }
    default: {
      throw new Error(`Unknown transport mode: ${(config as TransportConfig).mode}`);
    }
  }

  // Start health monitoring if health config provided
  if (healthConfig && config.mode !== 'local') {
    transport.startHealthMonitor(healthConfig);
  }

  // Auto-connect if requested (async, returns immediately)
  if (autoConnect) {
    transport.connect().catch((err) => {
      console.warn(`[transport-factory] Auto-connect failed for ${config.mode}:`, err);
    });
  }

  return transport;
}

/**
 * Create a transport from session parameters (the common case in CodePilot)
 */
export function createTransportForSession(params: {
  workspaceTransport: WorkspaceTransport;
  workingDirectory: string;
  remoteConnectionId?: string;
  remotePath?: string;
}): RuntimeTransport {
  const { workspaceTransport, workingDirectory, remoteConnectionId, remotePath } = params;

  if (workspaceTransport === 'local' || !remoteConnectionId) {
    return new LocalTransport({
      mode: 'local',
      workingDirectory,
    });
  }

  const connection = getRemoteConnection(remoteConnectionId);
  if (!connection) {
    throw new Error(`Remote connection not found: ${remoteConnectionId}`);
  }

  const effectiveRemotePath = remotePath || connection.remote_root || '/';

  if (workspaceTransport === 'ssh_direct') {
    return createSSHDirectTransport(connection, effectiveRemotePath);
  }

  throw new Error(`Unknown transport mode: ${workspaceTransport}`);
}

/**
 * Determine the best transport mode for a connection
 */
export function detectBestTransportMode(_connection: RemoteConnection): TransportMode {
  return 'ssh_direct';
}

/**
 * Get available transport modes for a connection
 */
export function getAvailableTransportModes(_connection: RemoteConnection): TransportMode[] {
  return ['ssh_direct'];
}
