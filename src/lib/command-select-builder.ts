import { buildCommandSelectContent, type CommandSelectOption } from '@/components/chat/CommandSelectBlock';

/**
 * Build interactive command-select content when a native command returns option lists.
 * Returns null if the response is not an interactive selection (e.g. invoked with args).
 *
 * @param currentModel - Fallback for current model when data doesn't include active_model
 *                       (Codex native controller doesn't return active_model in data)
 */
export function buildInteractiveContent(
  commandName: string,
  data: unknown,
  sessionId: string,
  engineType: string,
  currentModel?: string,
): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;

  // /model (no args) → model picker (Claude + Codex)
  if (commandName === 'model' && Array.isArray(d.models) && d.models.length > 0) {
    // Claude models use {value, displayName}, Codex uses {value, label, reasoning_efforts}
    const models = d.models as Array<{
      value: string;
      label?: string;
      displayName?: string;
      reasoning_efforts?: string[];
      default_reasoning_effort?: string;
    }>;
    const options: CommandSelectOption[] = models.map(m => ({
      value: m.value,
      label: m.label || m.displayName || m.value,
      subOptions: m.reasoning_efforts?.map(e => ({ value: e, label: e })),
      defaultSubOption: m.default_reasoning_effort,
    }));
    // Claude returns active_model in data; Codex doesn't, fall back to currentModel param
    const current = typeof d.active_model === 'string'
      ? d.active_model
      : currentModel;
    return buildCommandSelectContent({
      command: '/model',
      title: `${engineType.charAt(0).toUpperCase() + engineType.slice(1)} Model Selection`,
      current,
      options,
      sessionId,
      engineType,
    });
  }

  // /permissions (no args) → permission mode picker (Claude)
  if (commandName === 'permissions' && Array.isArray(d.supported_permission_modes)) {
    const modeLabels: Record<string, string> = {
      acceptEdits: 'Code (acceptEdits)',
      plan: 'Plan',
      default: 'Ask (default)',
      bypassPermissions: 'Bypass Permissions',
      dontAsk: "Don't Ask",
    };
    const modeAliases: Record<string, string> = {
      acceptEdits: 'code',
      plan: 'plan',
      default: 'ask',
      bypassPermissions: 'bypass',
      dontAsk: 'dontAsk',
    };
    const options: CommandSelectOption[] = (d.supported_permission_modes as string[]).map(mode => ({
      value: modeAliases[mode] || mode,
      label: modeLabels[mode] || mode,
    }));
    const current = typeof d.current_mode === 'string' ? d.current_mode : undefined;
    return buildCommandSelectContent({
      command: '/permissions',
      title: `${engineType.charAt(0).toUpperCase() + engineType.slice(1)} Permission Mode`,
      current,
      options,
      sessionId,
      engineType,
    });
  }

  // /permissions (no args) → approval policy picker (Codex)
  if (commandName === 'permissions' && Array.isArray(d.supported_policies)) {
    const policyLabels: Record<string, string> = {
      'suggest': 'Suggest',
      'auto-edit': 'Auto Edit',
      'full-auto': 'Full Auto',
    };
    const options: CommandSelectOption[] = (d.supported_policies as string[]).map(policy => ({
      value: policy,
      label: policyLabels[policy] || policy,
    }));
    const current = typeof d.approval_policy === 'string' ? d.approval_policy : undefined;
    return buildCommandSelectContent({
      command: '/permissions',
      title: `${engineType.charAt(0).toUpperCase() + engineType.slice(1)} Approval Policy`,
      current,
      options,
      sessionId,
      engineType,
    });
  }

  return null;
}
