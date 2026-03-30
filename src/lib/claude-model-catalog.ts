export interface ClaudeModelOption {
  value: string;
  label: string;
}

export const DEFAULT_CLAUDE_MODELS: ClaudeModelOption[] = [
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

export const PROVIDER_MODEL_LABELS: Record<string, ClaudeModelOption[]> = {
  'https://api.z.ai/api/anthropic': [
    { value: 'sonnet', label: 'GLM-4.7' },
    { value: 'opus', label: 'GLM-5' },
    { value: 'haiku', label: 'GLM-4.5-Air' },
  ],
  'https://open.bigmodel.cn/api/anthropic': [
    { value: 'sonnet', label: 'GLM-4.7' },
    { value: 'opus', label: 'GLM-5' },
    { value: 'haiku', label: 'GLM-4.5-Air' },
  ],
  'https://api.kimi.com/coding/': [
    { value: 'sonnet', label: 'Kimi K2.5' },
    { value: 'opus', label: 'Kimi K2.5' },
    { value: 'haiku', label: 'Kimi K2.5' },
  ],
  'https://api.moonshot.ai/anthropic': [
    { value: 'sonnet', label: 'Kimi K2.5' },
    { value: 'opus', label: 'Kimi K2.5' },
    { value: 'haiku', label: 'Kimi K2.5' },
  ],
  'https://api.moonshot.cn/anthropic': [
    { value: 'sonnet', label: 'Kimi K2.5' },
    { value: 'opus', label: 'Kimi K2.5' },
    { value: 'haiku', label: 'Kimi K2.5' },
  ],
  'https://api.minimaxi.com/anthropic': [
    { value: 'sonnet', label: 'MiniMax-M2.5' },
    { value: 'opus', label: 'MiniMax-M2.5' },
    { value: 'haiku', label: 'MiniMax-M2.5' },
  ],
  'https://api.minimax.io/anthropic': [
    { value: 'sonnet', label: 'MiniMax-M2.5' },
    { value: 'opus', label: 'MiniMax-M2.5' },
    { value: 'haiku', label: 'MiniMax-M2.5' },
  ],
  'https://openrouter.ai/api': [
    { value: 'sonnet', label: 'Sonnet 4.6' },
    { value: 'opus', label: 'Opus 4.6' },
    { value: 'haiku', label: 'Haiku 4.5' },
  ],
  'https://coding.dashscope.aliyuncs.com/apps/anthropic': [
    { value: 'qwen3.5-plus', label: 'Qwen 3.5 Plus' },
    { value: 'qwen3-coder-next', label: 'Qwen 3 Coder Next' },
    { value: 'qwen3-coder-plus', label: 'Qwen 3 Coder Plus' },
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
    { value: 'glm-5', label: 'GLM-5' },
    { value: 'glm-4.7', label: 'GLM-4.7' },
    { value: 'MiniMax-M2.5', label: 'MiniMax-M2.5' },
  ],
};

export function deduplicateClaudeModels(models: ClaudeModelOption[]): ClaudeModelOption[] {
  const seen = new Set<string>();
  const result: ClaudeModelOption[] = [];
  for (const model of models) {
    if (!seen.has(model.label)) {
      seen.add(model.label);
      result.push(model);
    }
  }
  return result;
}
