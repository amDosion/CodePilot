/**
 * Local command handlers — pure functions for commands executed entirely
 * in the browser without calling backend APIs.
 *
 * Each handler receives a context object and returns a result describing
 * what the UI should do (display a message, clear messages, navigate, etc.).
 */

import type { Message } from '@/types';
import type { RuntimeCommandMetadata } from '@/lib/runtime-command-catalog';
import type { TranslationKey } from '@/i18n';
import { buildRuntimeHelpMarkdown } from '@/lib/runtime-command-display';
import { buildInteractiveContent } from '@/lib/command-select-builder';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TranslationFn {
  (key: TranslationKey, vars?: Record<string, string | number>): string;
}

export interface LocalCommandContext {
  sessionId: string;
  engineType: string;
  messages: Message[];
  currentModel: string;
  currentProviderId: string;
  currentReasoningEffort: string;
  currentApprovalPolicy: string;
  mode: string;
  workingDirectory: string;
  runtimeCommands: RuntimeCommandMetadata[];
  t: TranslationFn;
}

export type LocalCommandAction =
  | { type: 'clearMessages' }
  | { type: 'navigate'; path: string }
  | { type: 'openPanel' }
  | { type: 'switchMode'; mode: string }
  | { type: 'openExternal'; url: string }
  | { type: 'copyLastResponse' }
  | { type: 'openFolderPicker' }
  | { type: 'fetchAbout' }
  | { type: 'fetchModelPicker' }
  | { type: 'toggleTheme' }
  | { type: 'fetchOAuthLogin'; engine: string }
  | { type: 'fetchLogout'; engine: string }
  | { type: 'fetchIdeStatus' };

export interface LocalCommandResult {
  /** Assistant message to display (if any). */
  message?: string;
  /** Side-effect action(s) to execute. */
  actions?: LocalCommandAction[];
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

type LocalHandler = (args: string, ctx: LocalCommandContext) => LocalCommandResult;

const handlers: Record<string, LocalHandler> = {};

function register(names: string[], handler: LocalHandler): void {
  for (const name of names) {
    handlers[name] = handler;
  }
}

// ---------------------------------------------------------------------------
// Individual handlers
// ---------------------------------------------------------------------------

register(['help', '?', 'commands'], (_args, ctx) => ({
  message: buildRuntimeHelpMarkdown(ctx.engineType, ctx.runtimeCommands, ctx.t),
}));

register(['clear'], (_args, ctx) => {
  const actions: LocalCommandAction[] = [{ type: 'clearMessages' }];
  return { actions };
});

register(['cost', 'stats'], (_args, ctx) => {
  const { messages, t, currentModel, currentProviderId, engineType, mode, currentReasoningEffort, workingDirectory } = ctx;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalCost = 0;
  let turnCount = 0;

  for (const msg of messages) {
    if (msg.token_usage) {
      try {
        const usage = typeof msg.token_usage === 'string' ? JSON.parse(msg.token_usage) : msg.token_usage;
        totalInput += usage.input_tokens || 0;
        totalOutput += usage.output_tokens || 0;
        totalCacheRead += usage.cache_read_input_tokens || 0;
        totalCacheCreation += usage.cache_creation_input_tokens || 0;
        if (usage.cost_usd) totalCost += usage.cost_usd;
        turnCount++;
      } catch { /* skip malformed */ }
    }
  }

  const totalTokens = totalInput + totalOutput;
  let content: string;

  if (turnCount === 0) {
    content = `## ${t('chat.costTitle')}\n\n${t('chat.costNoData')}`;
  } else {
    content = `## ${t('chat.costTitle')}\n\n| ${t('chat.costMetric')} | ${t('chat.costCount')} |\n|--------|-------|\n| ${t('chat.costInputTokens')} | ${totalInput.toLocaleString()} |\n| ${t('chat.costOutputTokens')} | ${totalOutput.toLocaleString()} |\n| ${t('chat.costCacheRead')} | ${totalCacheRead.toLocaleString()} |\n| ${t('chat.costCacheCreation')} | ${totalCacheCreation.toLocaleString()} |\n| **${t('chat.costTotalTokens')}** | **${totalTokens.toLocaleString()}** |\n| ${t('chat.costTurns')} | ${turnCount} |${totalCost > 0 ? `\n| **${t('chat.costEstimatedCost')}** | **$${totalCost.toFixed(4)}** |` : ''}`;
  }

  return { message: content };
});

register(['status'], (_args, ctx) => {
  const { messages, t, currentModel, currentProviderId, engineType, mode, currentReasoningEffort, workingDirectory } = ctx;

  const runtimeLabel = engineType === 'codex'
    ? t('chatList.providerCodex')
    : engineType === 'gemini'
      ? t('chatList.providerGemini')
      : t('chatList.providerClaude');

  // Build status header
  const statusHeader = `## ${t('chat.statusTitle')}\n\n- **${t('chat.statusRuntime')}**: ${runtimeLabel}\n- **${t('chat.statusModel')}**: ${currentModel}\n- **${t('chat.statusProvider')}**: ${currentProviderId}\n- **${t('chat.statusMode')}**: ${mode}\n${engineType === 'codex' && currentReasoningEffort ? `- **${t('chat.statusReasoning')}**: ${currentReasoningEffort}\n` : ''}${workingDirectory ? `- **${t('chat.statusProject')}**: ${workingDirectory}` : `- **${t('chat.statusProject')}**: ${t('chat.statusProjectUnset')}`}`;

  // Build cost section
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalCost = 0;
  let turnCount = 0;

  for (const msg of messages) {
    if (msg.token_usage) {
      try {
        const usage = typeof msg.token_usage === 'string' ? JSON.parse(msg.token_usage) : msg.token_usage;
        totalInput += usage.input_tokens || 0;
        totalOutput += usage.output_tokens || 0;
        totalCacheRead += usage.cache_read_input_tokens || 0;
        totalCacheCreation += usage.cache_creation_input_tokens || 0;
        if (usage.cost_usd) totalCost += usage.cost_usd;
        turnCount++;
      } catch { /* skip malformed */ }
    }
  }

  const totalTokens = totalInput + totalOutput;
  let costSection: string;

  if (turnCount === 0) {
    costSection = `## ${t('chat.costTitle')}\n\n${t('chat.costNoData')}`;
  } else {
    costSection = `## ${t('chat.costTitle')}\n\n| ${t('chat.costMetric')} | ${t('chat.costCount')} |\n|--------|-------|\n| ${t('chat.costInputTokens')} | ${totalInput.toLocaleString()} |\n| ${t('chat.costOutputTokens')} | ${totalOutput.toLocaleString()} |\n| ${t('chat.costCacheRead')} | ${totalCacheRead.toLocaleString()} |\n| ${t('chat.costCacheCreation')} | ${totalCacheCreation.toLocaleString()} |\n| **${t('chat.costTotalTokens')}** | **${totalTokens.toLocaleString()}** |\n| ${t('chat.costTurns')} | ${turnCount} |${totalCost > 0 ? `\n| **${t('chat.costEstimatedCost')}** | **$${totalCost.toFixed(4)}** |` : ''}`;
  }

  return { message: `${statusHeader}\n\n${costSection}` };
});

register(['exit', 'quit'], (_args, _ctx) => ({
  actions: [{ type: 'navigate', path: '/chat' }],
}));

register(['new'], (_args, _ctx) => ({
  actions: [{ type: 'navigate', path: '/chat' }],
}));

register(['plan'], (_args, ctx) => {
  const newMode = ctx.mode === 'plan' ? 'code' : 'plan';
  return {
    message: ctx.t('chat.modeSwitched', { mode: newMode }),
    actions: [{ type: 'switchMode', mode: newMode }],
  };
});

register(['resume', 'chat'], (_args, _ctx) => ({
  actions: [{ type: 'openPanel' }],
}));

register(['copy'], (_args, ctx) => {
  return { actions: [{ type: 'copyLastResponse' }] };
});

register(['docs'], (_args, ctx) => {
  const urls: Record<string, string> = {
    claude: 'https://docs.anthropic.com/en/docs/claude-code',
    codex: 'https://github.com/openai/codex',
    gemini: 'https://ai.google.dev/gemini-api/docs',
  };
  const url = urls[ctx.engineType] || urls.claude;
  return {
    message: ctx.t('chat.docsOpened'),
    actions: [{ type: 'openExternal', url }],
  };
});

register(['privacy'], (_args, ctx) => ({
  message: ctx.t('chat.privacyNotice'),
}));

register(['bug'], (_args, ctx) => {
  if (ctx.engineType === 'gemini') {
    return { message: ctx.t('chat.bugReportGemini') };
  }
  if (ctx.engineType === 'codex') {
    return { message: 'To report a bug, visit [github.com/openai/codex/issues](https://github.com/openai/codex/issues).' };
  }
  return { message: ctx.t('chat.bugReportClaude') };
});

register(['feedback'], (_args, ctx) => {
  if (ctx.engineType === 'claude') {
    return {
      message: 'To send feedback about Claude, visit [github.com/anthropics/claude-code/issues](https://github.com/anthropics/claude-code/issues).',
    };
  }
  if (ctx.engineType === 'gemini') {
    return {
      message: 'To send feedback about Gemini CLI, visit [github.com/google-gemini/gemini-cli/issues](https://github.com/google-gemini/gemini-cli/issues).',
    };
  }
  return {
    message: ctx.t('chat.feedbackCodex'),
  };
});

register(['add-dir'], (_args, _ctx) => ({
  actions: [{ type: 'openFolderPicker' }],
}));

register(['about', 'version'], (_args, _ctx) => ({
  actions: [{ type: 'fetchAbout' }],
}));

register(['mention'], (_args, ctx) => ({
  message: ctx.t('chat.mentionHint'),
}));

register(['sandbox-add-read-dir'], (_args, ctx) => ({
  message: ctx.t('chat.sandboxReadDirHint'),
}));

register(['setup-github'], (_args, ctx) => ({
  message: ctx.t('chat.setupGithubHint'),
}));

register(['apps'], (_args, ctx) => ({
  message: ctx.t('chat.appsCodex'),
}));

register(['history'], (_args, _ctx) => ({
  actions: [{ type: 'navigate', path: '/chat' }],
}));

register(['model'], (_args, _ctx) => ({
  actions: [{ type: 'fetchModelPicker' }],
}));

register(['shortcuts'], (_args, ctx) => ({
  message: `## ${ctx.t('chat.helpTitle')}\n\n- **Ctrl+Enter** / **Cmd+Enter**: Send message\n- **Shift+Enter**: New line\n- **Ctrl+L**: Clear conversation\n- **Up Arrow**: Edit last message`,
}));

register(['directory'], (_args, ctx) => ({
  message: ctx.workingDirectory
    ? `Current working directory: \`${ctx.workingDirectory}\``
    : ctx.t('chat.statusProjectUnset'),
}));

register(['corgi'], (_args, _ctx) => ({
  message: '🐕 *woof!*',
}));

register(['fast'], (_args, ctx) => {
  // /fast toggles between standard and fast output modes
  // In the GUI context, this is advisory — model selection controls actual speed
  const currentEffort = ctx.currentReasoningEffort || 'default';
  return {
    message: [
      '## Fast Mode',
      '',
      `Current reasoning effort: \`${currentEffort}\``,
      '',
      'In CodePilot GUI, use the model selector to switch between models,',
      'or adjust reasoning effort in the toolbar for supported models.',
      '',
      'Fast mode in the CLI maps to lower reasoning effort or a faster model variant.',
    ].join('\n'),
  };
});


register(['login'], (_args, ctx) => {
  const runtimeLabel = ctx.engineType === 'codex'
    ? ctx.t('chatList.providerCodex')
    : ctx.engineType === 'gemini'
      ? ctx.t('chatList.providerGemini')
      : ctx.t('chatList.providerClaude');
  return {
    message: `## OAuth Login

Initiating OAuth login for **${runtimeLabel}**...

A login URL will appear shortly. Click it to authenticate in your browser.`,
    actions: [{ type: 'fetchOAuthLogin', engine: ctx.engineType }],
  };
});

register(['logout'], (_args, ctx) => {
  const runtimeLabel = ctx.engineType === 'codex'
    ? ctx.t('chatList.providerCodex')
    : ctx.engineType === 'gemini'
      ? ctx.t('chatList.providerGemini')
      : ctx.t('chatList.providerClaude');
  return {
    message: `Logging out of **${runtimeLabel}**...`,
    actions: [{ type: 'fetchLogout', engine: ctx.engineType }],
  };
});

register(['theme'], (_args, _ctx) => ({
  message: 'Theme toggled.',
  actions: [{ type: 'toggleTheme' }],
}));

register(['ide'], (_args, _ctx) => ({
  message: 'Checking IDE connection status...',
  actions: [{ type: 'fetchIdeStatus' }],
}));
// ---------------------------------------------------------------------------
// CLI-only handler (used for any command with execution === 'cli-only')
// ---------------------------------------------------------------------------

export function buildCliOnlyMessage(commandName: string, engineType: string, t: TranslationFn): string {
  const runtime = engineType === 'codex'
    ? t('chatList.providerCodex')
    : engineType === 'gemini'
      ? t('chatList.providerGemini')
      : t('chatList.providerClaude');
  return `## ${t('chat.cliOnlyCommandTitle')}\n\n${t('chat.cliOnlyCommandDesc', {
    command: `/${commandName}`,
    runtime,
  })}`;
}

// Some cli-only commands have special redirect behavior
const CLI_ONLY_REDIRECTS: Record<string, (ctx: LocalCommandContext) => LocalCommandResult> = {
  config: (_ctx) => ({
    message: '## Configuration\n\nOpening the Settings page where you can configure API keys, models, CLI runtimes, and preferences.',
    actions: [{ type: 'navigate', path: '/settings' }],
  }),
  search: (_ctx) => ({
    message: 'Use the search bar at the top of the chat list panel to search conversations.',
    actions: [{ type: 'openPanel' }],
  }),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle a local command. Returns null if the command is not recognized
 * as a local command.
 */
export function handleLocalCommand(
  commandName: string,
  args: string,
  ctx: LocalCommandContext,
): LocalCommandResult | null {
  const handler = handlers[commandName];
  if (handler) {
    return handler(args, ctx);
  }
  return null;
}

/**
 * Handle a CLI-only command with optional redirect behavior.
 */
export function handleCliOnlyCommand(
  commandName: string,
  ctx: LocalCommandContext,
): LocalCommandResult {
  const redirect = CLI_ONLY_REDIRECTS[commandName];
  if (redirect) {
    const result = redirect(ctx);
    // Also add the cli-only message if no message is set
    if (!result.message) {
      result.message = buildCliOnlyMessage(commandName, ctx.engineType, ctx.t);
    }
    return result;
  }
  return { message: buildCliOnlyMessage(commandName, ctx.engineType, ctx.t) };
}
