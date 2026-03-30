import { normalizeEngineType as normalizeKnownEngineType } from '@/lib/engine-defaults';
import type { AgentEngineType, EngineFactoryOptions } from './types';

export const DEFAULT_ENGINE_TYPE: AgentEngineType = 'claude';

function normalizeEngineType(value: string | null | undefined): AgentEngineType {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_ENGINE_TYPE;
  }
  if (normalized === 'claude' || normalized === 'codex' || normalized === 'gemini') {
    return normalizeKnownEngineType(normalized) as AgentEngineType;
  }
  return normalized as AgentEngineType;
}

export function resolveEngineType(options: EngineFactoryOptions = {}): AgentEngineType {
  return normalizeEngineType(options.engine ?? options.session?.engine_type);
}
