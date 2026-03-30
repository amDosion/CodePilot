import type { ProviderModelGroup } from '@/types';
import { normalizeReasoningEffort } from '@/lib/engine-defaults';

const FALLBACK_CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

export type CodexModelOption = ProviderModelGroup['models'][number];

export const DEFAULT_CODEX_MODEL_OPTIONS: CodexModelOption[] = [
  {
    value: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
    default_reasoning_effort: 'medium',
  },
  {
    value: 'gpt-5.4',
    label: 'GPT-5.4',
    reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
    default_reasoning_effort: 'medium',
  },
  {
    value: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
    default_reasoning_effort: 'high',
  },
  {
    value: 'gpt-5.2-codex',
    label: 'GPT-5.2 Codex',
    reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
    default_reasoning_effort: 'medium',
  },
  {
    value: 'gpt-5.1-codex-max',
    label: 'GPT-5.1 Codex Max',
    reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
    default_reasoning_effort: 'medium',
  },
  {
    value: 'gpt-5.2',
    label: 'GPT-5.2',
    reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
    default_reasoning_effort: 'medium',
  },
  {
    value: 'gpt-5.1-codex-mini',
    label: 'GPT-5.1 Codex Mini',
    reasoning_efforts: ['medium', 'high'],
    default_reasoning_effort: 'medium',
  },
];

function normalizeReasoningEfforts(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const normalized = values
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const raw = 'reasoningEffort' in entry ? (entry as { reasoningEffort?: unknown }).reasoningEffort : undefined;
      return normalizeReasoningEffort(typeof raw === 'string' ? raw : '');
    })
    .filter((effort): effort is NonNullable<typeof effort> => !!effort);

  return Array.from(new Set(normalized));
}

/**
 * Convert Codex app-server model/list payloads into provider model options.
 */
export function normalizeCodexModelListPayload(payload: unknown): CodexModelOption[] {
  if (!Array.isArray(payload)) return [];

  const options: CodexModelOption[] = [];

  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as {
      id?: unknown;
      model?: unknown;
      displayName?: unknown;
      hidden?: unknown;
      supportedReasoningEfforts?: unknown;
      defaultReasoningEffort?: unknown;
    };

    if (model.hidden === true) continue;

    const value = typeof model.model === 'string'
      ? model.model
      : (typeof model.id === 'string' ? model.id : '');
    if (!value) continue;

    const label = typeof model.displayName === 'string'
      ? model.displayName
      : value;

    const reasoningEfforts = normalizeReasoningEfforts(model.supportedReasoningEfforts);
    const defaultReasoningEffort = normalizeReasoningEffort(
      typeof model.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort : ''
    ) || (reasoningEfforts[0] ?? 'medium');

    options.push({
      value,
      label,
      reasoning_efforts: reasoningEfforts.length > 0 ? reasoningEfforts : [...FALLBACK_CODEX_REASONING_EFFORTS],
      default_reasoning_effort: defaultReasoningEffort,
    });
  }

  const deduped = options.filter((option, index, arr) =>
    arr.findIndex((candidate) => candidate.value === option.value) === index
  );

  return deduped;
}
