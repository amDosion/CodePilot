/**
 * Transport Layer — barrel export
 */

// Types
export type {
  TransportMode,
  TransportStatus,
  TransportHealthResult,
  TransportState,
  TransportConfig,
  TransportConfigBase,
  LocalTransportConfig,
  SSHDirectTransportConfig,
  HealthMonitorConfig,
  TransportEventType,
  TransportEvent,
  TransportEventListener,
  ExecuteOptions,
  ExecuteResult,
  SpawnTransportOptions,
  FileInfo,
  RuntimeTransport,
  CreateTransportOptions,
  TransportFactory,
} from './types';

export {
  DEFAULT_HEALTH_MONITOR_CONFIG,
  isLocalConfig,
  isSSHDirectConfig,
} from './types';

// Implementations
export { LocalTransport, createLocalTransport, createLocalTransportFromConfig } from './local-transport';
export { SSHDirectTransport, createSSHDirectTransport } from './ssh-direct-transport';

// Factory
export {
  createTransport,
  createTransportForSession,
  detectBestTransportMode,
  getAvailableTransportModes,
} from './transport-factory';
