import type { ClaudeStreamOptions } from '@/types';

export type AgentEngineType = 'claude' | 'codex' | 'gemini' | (string & {});

export type EngineCapability =
  | 'streaming'
  | 'session_resume'
  | 'permission_mode'
  | 'native_control'
  | 'mcp'
  | 'vision'
  | 'tool_calling';

export interface EngineStreamOptions extends Omit<ClaudeStreamOptions, 'sdkSessionId'> {
  /** Engine-native session/thread identifier. */
  engineSessionId?: string;
  /** Backward-compatible alias for Claude integration. */
  sdkSessionId?: string;
}

export interface AgentEngine {
  readonly type: AgentEngineType;
  readonly capabilities: readonly EngineCapability[];
  stream(options: EngineStreamOptions): ReadableStream<string>;
}

export interface EngineFactoryOptions {
  engine?: AgentEngineType | null;
  session?: { engine_type?: string | null } | null;
}
