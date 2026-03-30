export type EngineType = 'claude' | 'codex' | 'gemini';

export function normalizeEngineType(engine?: string | null): EngineType {
  const normalized = (engine || '').trim().toLowerCase();
  if (normalized === 'codex') return 'codex';
  if (normalized === 'gemini') return 'gemini';
  return 'claude';
}

export function isCodexEngine(engine?: string | null): boolean {
  return normalizeEngineType(engine) === 'codex';
}

export function isGeminiEngine(engine?: string | null): boolean {
  return normalizeEngineType(engine) === 'gemini';
}

export function normalizeReasoningEffort(
  value?: string | null,
  _engine?: string | null,
): string {
  // Accept any non-empty value — validation is done by the model's
  // supportedReasoningEfforts, not by a hardcoded list here.
  return (value || '').trim().toLowerCase();
}
