import type { TranslationKey } from '@/i18n';

export type RuntimeCommandAvailability =
  | 'supported'
  | 'requires-session'
  | 'requires-runtime'
  | 'gui-unsupported'
  | 'cli-only';

export type RuntimeCommandExecution =
  | 'local'
  | 'native'
  | 'stream'
  | 'prompt'
  | 'terminal'
  | 'immediate'
  | 'cli-only'
  | 'unsupported';

export type RuntimeCommandSource = 'official' | 'codepilot';

/**
 * Semantic classification of slash commands.
 * - local: UI-only actions
 * - session: modify runtime/session state
 * - prompt: expands into a normal prompt turn
 * - mcp: tools / MCP / app integration
 * - agent: agent or thread operations
 */
export type RuntimeCommandMode = 'local' | 'session' | 'prompt' | 'mcp' | 'agent';

export interface RuntimeCommandMetadata {
  name: string;
  description: string;
  aliases: string[];
  subCommands: string[];
  availability: RuntimeCommandAvailability;
  execution: RuntimeCommandExecution;
  source: RuntimeCommandSource;
  prompt?: string;
  /** Semantic command mode used for grouping and display. */
  commandMode?: RuntimeCommandMode;
  /** Placeholder hint for arguments, e.g. "<model-id> [effort]". */
  argsHint?: string;
  /** Static list of valid argument options (for autocomplete). */
  argsOptions?: string[];
  /** CLI command to execute (for terminal execution mode). */
  cliCommand?: string;
}

const DESCRIPTION_KEYS: Record<string, Record<string, TranslationKey>> = {
  claude: {
    compact: 'messageInput.compactDesc',
    review: 'messageInput.reviewDesc',
  },
  codex: {
    compact: 'messageInput.compactDesc',
    review: 'messageInput.reviewDesc',
  },
};

export function splitRuntimeCommands(commands: RuntimeCommandMetadata[]): {
  supported: RuntimeCommandMetadata[];
  cliOnly: RuntimeCommandMetadata[];
  requiresSession: RuntimeCommandMetadata[];
  requiresRuntime: RuntimeCommandMetadata[];
  unsupported: RuntimeCommandMetadata[];
} {
  const supported: RuntimeCommandMetadata[] = [];
  const cliOnly: RuntimeCommandMetadata[] = [];
  const requiresSession: RuntimeCommandMetadata[] = [];
  const requiresRuntime: RuntimeCommandMetadata[] = [];
  const unsupported: RuntimeCommandMetadata[] = [];

  for (const command of commands) {
    switch (command.availability) {
      case 'supported':
        supported.push(command);
        break;
      case 'cli-only':
        cliOnly.push(command);
        break;
      case 'requires-session':
        requiresSession.push(command);
        break;
      case 'requires-runtime':
        requiresRuntime.push(command);
        break;
      default:
        unsupported.push(command);
        break;
    }
  }

  return { supported, cliOnly, requiresSession, requiresRuntime, unsupported };
}

export function formatRuntimeCommandLine(
  command: RuntimeCommandMetadata,
  descriptionOverride?: string,
): string {
  const subCommands = command.subCommands.length > 0
    ? ` (${command.subCommands.join(', ')})`
    : '';
  const suffix = command.source === 'codepilot' ? ' (CodePilot)' : '';
  return `- **/${command.name}** — ${descriptionOverride || command.description}${subCommands}${suffix}`;
}

export function findRuntimeCommand(
  commands: RuntimeCommandMetadata[],
  input: string,
): RuntimeCommandMetadata | null {
  const normalized = input.trim().split(/\s+/)[0]?.replace(/^\//, '').toLowerCase() || '';
  if (!normalized) return null;

  return commands.find((command) => (
    command.name.toLowerCase() === normalized
    || command.aliases.some((alias) => alias.toLowerCase() === normalized)
  )) || null;
}

export function getRuntimeCommandDescriptionKey(
  engineType: string,
  commandName: string,
): TranslationKey | null {
  return DESCRIPTION_KEYS[engineType]?.[commandName] || null;
}

export function getRuntimeHelpSectionTitleKey(engineType: string): TranslationKey {
  return engineType === 'gemini'
    ? 'chat.helpCustomCommands'
    : 'chat.helpCustomSkills';
}

export function getRuntimeHelpPathHintKey(engineType: string): TranslationKey {
  if (engineType === 'codex') return 'chat.helpSkillPathCodex';
  if (engineType === 'gemini') return 'chat.helpSkillPathGemini';
  return 'chat.helpSkillPathClaude';
}

export function getRuntimeBrowseHintKey(engineType: string): TranslationKey {
  return engineType === 'gemini'
    ? 'chat.helpBrowseCommands'
    : 'chat.helpBrowseCommandsAndSkills';
}
