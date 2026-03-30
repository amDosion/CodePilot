import type { TranslationKey } from '@/i18n';
import type { RuntimeCommandMetadata } from '@/lib/runtime-command-catalog';
import {
  formatRuntimeCommandLine,
  getRuntimeBrowseHintKey,
  getRuntimeCommandDescriptionKey,
  getRuntimeHelpPathHintKey,
  getRuntimeHelpSectionTitleKey,
  splitRuntimeCommands,
} from '@/lib/runtime-command-catalog';

interface TranslationFn {
  (key: TranslationKey, vars?: Record<string, string | number>): string;
}

function getDisplayDescription(
  engineType: string,
  command: RuntimeCommandMetadata,
  t: TranslationFn,
): string {
  const key = getRuntimeCommandDescriptionKey(engineType, command.name);
  return key ? t(key) : command.description;
}

export function buildRuntimeHelpMarkdown(
  engineType: string,
  commands: RuntimeCommandMetadata[],
  t: TranslationFn,
): string {
  const { supported, cliOnly } = splitRuntimeCommands(commands);
  const supportedLines = supported
    .map((command) => formatRuntimeCommandLine(command, getDisplayDescription(engineType, command, t)))
    .join('\n');
  const cliOnlyLines = cliOnly
    .map((command) => formatRuntimeCommandLine(command, command.description))
    .join('\n');
  const customSectionTitle = t(getRuntimeHelpSectionTitleKey(engineType));
  const skillPathHint = t(getRuntimeHelpPathHintKey(engineType));
  const browseHint = t(getRuntimeBrowseHintKey(engineType));

  const sections = [
    `## ${t('chat.helpTitle')}`,
  ];

  if (supportedLines) {
    sections.push(`### ${t('chat.helpSupportedCommands')}`);
    sections.push(supportedLines);
  }

  if (cliOnlyLines) {
    sections.push(`### ${t('chat.helpCliOnlyCommands')}`);
    sections.push(cliOnlyLines);
  }

  sections.push(`### ${customSectionTitle}`);
  sections.push(skillPathHint);
  sections.push(`**${t('chat.helpTips')}:**`);
  sections.push(`- ${browseHint}`);
  sections.push(`- ${t('chat.helpMentionFiles')}`);
  sections.push(`- ${t('chat.helpShiftEnter')}`);
  sections.push(`- ${t('chat.helpSelectProject')}`);

  return sections.join('\n\n');
}
