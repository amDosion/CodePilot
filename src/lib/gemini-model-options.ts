import type { ProviderModelGroup } from '@/types';

export type GeminiModelOption = ProviderModelGroup['models'][number];

export const GEMINI_AUTO_GEMINI_3 = 'auto-gemini-3';
export const GEMINI_AUTO_GEMINI_25 = 'auto-gemini-2.5';

export const GEMINI_AUTO_MODEL_OPTIONS: GeminiModelOption[] = [
  {
    value: GEMINI_AUTO_GEMINI_3,
    label: 'Auto (Gemini 3)',
  },
  {
    value: GEMINI_AUTO_GEMINI_25,
    label: 'Auto (Gemini 2.5)',
  },
];

export const GEMINI_MANUAL_MODEL_OPTIONS: GeminiModelOption[] = [
  {
    value: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
  },
  {
    value: 'gemini-3-pro-preview',
    label: 'Gemini 3 Pro Preview',
  },
  {
    value: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash Preview',
  },
  {
    value: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
  },
  {
    value: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
  },
  {
    value: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
  },
];

export const DEFAULT_GEMINI_MODEL_OPTIONS: GeminiModelOption[] = [
  ...GEMINI_AUTO_MODEL_OPTIONS,
  ...GEMINI_MANUAL_MODEL_OPTIONS,
];

export function isGeminiAutoModel(model?: string | null): boolean {
  return model === GEMINI_AUTO_GEMINI_3 || model === GEMINI_AUTO_GEMINI_25;
}

export function getGeminiModelLabel(
  model?: string | null,
  models: GeminiModelOption[] = DEFAULT_GEMINI_MODEL_OPTIONS,
): string {
  const normalizedModel = (model || '').trim();
  if (!normalizedModel) {
    return GEMINI_AUTO_MODEL_OPTIONS[1].label;
  }

  const matched = models.find((option) => option.value === normalizedModel);
  return matched?.label || normalizedModel;
}

export function getGeminiManualMenuLabel(
  model?: string | null,
  models: GeminiModelOption[] = DEFAULT_GEMINI_MODEL_OPTIONS,
): string {
  const normalizedModel = (model || '').trim();
  if (!normalizedModel || isGeminiAutoModel(normalizedModel)) {
    return 'Manual';
  }

  return `Manual (${getGeminiModelLabel(normalizedModel, models)})`;
}

export function getGeminiManualModelOptions(
  models: GeminiModelOption[] = DEFAULT_GEMINI_MODEL_OPTIONS,
  preferredModel?: string | null,
): GeminiModelOption[] {
  const merged = [...models];
  const normalizedPreferred = (preferredModel || '').trim();

  if (
    normalizedPreferred
    && !isGeminiAutoModel(normalizedPreferred)
    && !merged.some((option) => option.value === normalizedPreferred)
  ) {
    merged.unshift({
      value: normalizedPreferred,
      label: normalizedPreferred,
    });
  }

  const deduped: GeminiModelOption[] = [];
  const seen = new Set<string>();

  for (const option of merged) {
    if (isGeminiAutoModel(option.value) || seen.has(option.value)) {
      continue;
    }
    seen.add(option.value);
    deduped.push(option);
  }

  return deduped;
}
