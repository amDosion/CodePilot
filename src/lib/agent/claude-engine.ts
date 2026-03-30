import { streamClaudePersistent } from '@/lib/claude-persistent-client';
import type { AgentEngine, EngineCapability, EngineStreamOptions } from './types';

const CLAUDE_CAPABILITIES: readonly EngineCapability[] = [
  'streaming',
  'session_resume',
  'permission_mode',
  'native_control',
  'mcp',
  'vision',
  'tool_calling',
];

export class ClaudeEngine implements AgentEngine {
  readonly type = 'claude' as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  stream(options: EngineStreamOptions): ReadableStream<string> {
    const { engineSessionId, sdkSessionId, ...rest } = options;
    return streamClaudePersistent({
      ...rest,
      sdkSessionId: engineSessionId ?? sdkSessionId,
    });
  }
}
