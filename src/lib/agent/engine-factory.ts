import { ClaudeEngine } from './claude-engine';
import { CodexEngine } from './codex-engine';
import { GeminiEngine } from './gemini-engine';
import { DEFAULT_ENGINE_TYPE, resolveEngineType } from './engine-resolver';
import type { AgentEngine, EngineFactoryOptions } from './types';
export { DEFAULT_ENGINE_TYPE, resolveEngineType } from './engine-resolver';

export function createAgentEngine(options: EngineFactoryOptions = {}): AgentEngine {
  const engineType = resolveEngineType(options);

  switch (engineType) {
    case 'claude':
      return new ClaudeEngine();
    case 'codex':
      return new CodexEngine();
    case 'gemini':
      return new GeminiEngine();
    default:
      console.warn(
        `[agent-engine] Unsupported engine type "${engineType}", falling back to "${DEFAULT_ENGINE_TYPE}"`,
      );
      return new ClaudeEngine();
  }
}
