/**
 * Hardcoded fallback command lists — last resort when dynamic loading fails.
 *
 * These are the single source of truth for fallback commands. Every command
 * that has a backend handler in the native controllers MUST be listed here.
 */

import type { RuntimeCommandMetadata } from './types';

// ---------------------------------------------------------------------------
// CodePilot-specific commands (shared across all engines)
// ---------------------------------------------------------------------------

export const CODEPILOT_COMMANDS: RuntimeCommandMetadata[] = [
  {
    name: 'clear',
    description: 'Clear current conversation display',
    aliases: [],
    subCommands: [],
    availability: 'supported',
    execution: 'immediate',
    source: 'codepilot',
    commandMode: 'local',
  },
  {
    name: 'help',
    description: 'Show available commands',
    aliases: ['?'],
    subCommands: [],
    availability: 'supported',
    execution: 'immediate',
    source: 'codepilot',
    commandMode: 'local',
  },
];

// ---------------------------------------------------------------------------
// Claude fallback commands
// ---------------------------------------------------------------------------

export const CLAUDE_FALLBACK_COMMANDS: RuntimeCommandMetadata[] = [
  // --- Native controller commands (execution: 'immediate', commandMode !== 'local') ---
  { name: 'model', description: 'View or change the current model', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session', argsHint: '[model-id]' },
  { name: 'permissions', description: 'View or change permission mode', aliases: [], subCommands: ['ask', 'code', 'plan', 'bypass', 'dont-ask'], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'status', description: 'Show session status', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'mcp', description: 'Show MCP server status', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'mcp' },
  { name: 'doctor', description: 'Check environment health', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'memory', description: 'View CLAUDE.md files', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'agents', description: 'List configured agents', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'agent' },
  { name: 'pr_comments', description: 'Show PR comments', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'pr-comments', description: 'Get comments from a GitHub pull request', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'diff', description: 'Show git diff summary', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'hooks', description: 'View hook configurations for tool events', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'skills', description: 'List available skills', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'mcp' },
  { name: 'advisor', description: 'Configure the advisor model', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'effort', description: 'Set effort level for model usage', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'context', description: 'Visualize current context usage', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'files', description: 'List all files currently in context', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'extra-usage', description: 'Configure extra usage when limits are hit', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'chrome', description: 'Claude in Chrome settings', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },

  // --- Stream commands ---
  { name: 'compact', description: 'Compact conversation history', aliases: [], subCommands: [], availability: 'supported', execution: 'stream', source: 'official', commandMode: 'session' },
  { name: 'review', description: 'Start a code review', aliases: [], subCommands: [], availability: 'supported', execution: 'stream', source: 'official', commandMode: 'prompt' },

  // --- Prompt commands ---
  { name: 'init', description: 'Initialize CLAUDE.md', aliases: [], subCommands: [], availability: 'supported', execution: 'prompt', source: 'official', commandMode: 'prompt' },
  { name: 'commit', description: 'Create a git commit', aliases: [], subCommands: [], availability: 'supported', execution: 'prompt', source: 'official', commandMode: 'prompt' },
  { name: 'commit-push-pr', description: 'Commit, push, and open a PR', aliases: [], subCommands: [], availability: 'supported', execution: 'prompt', source: 'official', commandMode: 'prompt' },

  // --- Local UI commands ---
  { name: 'cost', description: 'Show token usage and costs', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'about', description: 'Show Claude CLI version', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'add-dir', description: 'Add directory to workspace', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local', argsHint: '<directory>' },
  { name: 'chat', description: 'Open chat panel', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'docs', description: 'Open documentation', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'exit', description: 'Exit the session', aliases: ['quit'], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'fast', description: 'Switch to fast output mode', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'feedback', description: 'Send feedback', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'fork', description: 'Fork current conversation', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'plan', description: 'Enter plan mode', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'resume', description: 'Resume a previous session', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'version', description: 'Show CLI version', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'history', description: 'Browse conversation history', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'new', description: 'Start new session', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'undo', description: 'Undo last changes', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'apps', description: 'List available apps', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'copy', description: 'Copy last response to clipboard', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'stats', description: 'Show usage statistics and activity', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'rename', description: 'Rename the current conversation', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'tag', description: 'Toggle a searchable tag on the session', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'export', description: 'Export conversation to a file or clipboard', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'brief', description: 'Toggle brief-only mode', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'alias', description: 'Create or list command aliases', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session', argsHint: '[name=value]' },
  { name: 'color', description: 'Set the prompt bar color for this session', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'usage', description: 'Show plan usage limits', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'stickers', description: 'Order Claude Code stickers', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'think-back', description: 'Your 2025 Claude Code Year in Review', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'upgrade', description: 'Upgrade to Max for higher rate limits', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },

  // --- CLI-only commands ---
  { name: 'login', description: 'Log in to Claude', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'logout', description: 'Log out of Claude', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'config', description: 'View or update settings', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'bug', description: 'Report a bug', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'vim', description: 'Toggle vim keybindings', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
  { name: 'terminal-setup', description: 'Setup terminal integration', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
  { name: 'search', description: 'Search conversations', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'theme', description: 'Change theme', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'ide', description: 'Show IDE connection info', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'debug', description: 'Enable debug logging for this session', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'keybindings', description: 'Open keybindings configuration file', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
  { name: 'privacy-settings', description: 'View and update privacy settings', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'rate-limit-options', description: 'Show options when rate limit is reached', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'reload-plugins', description: 'Activate pending plugin changes', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'remote-env', description: 'Configure default remote environment', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'voice', description: 'Toggle voice mode', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'web-setup', description: 'Setup Claude Code on the web', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
  { name: 'output-style', description: 'Deprecated: use /config to change output style', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'install-github-app', description: 'Set up Claude GitHub Actions for a repository', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
  { name: 'install-slack-app', description: 'Install the Claude Slack app', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
];

// ---------------------------------------------------------------------------
// Codex fallback commands
// ---------------------------------------------------------------------------

export const CODEX_FALLBACK_COMMANDS: RuntimeCommandMetadata[] = [
  // --- Native controller commands ---
  { name: 'model', description: 'View or change the current model', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session', argsHint: '[model-id] [reasoning-effort]' },
  { name: 'permissions', description: 'View or change approval policy', aliases: [], subCommands: ['suggest', 'auto-edit', 'full-auto'], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'status', description: 'Show session status', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'mcp', description: 'Show MCP server status', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'mcp' },
  { name: 'fork', description: 'Fork current conversation', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'diff', description: 'Show git diff summary', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'agent', description: 'Show agent threads', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'agent' },
  { name: 'experimental', description: 'Show experimental features', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'personality', description: 'Show collaboration mode', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'ps', description: 'Show process status', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'debug-config', description: 'Show config diagnostics', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'skills', description: 'List available skills', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'mcp' },
  { name: 'apps', description: 'List available apps', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'mcp' },
  { name: 'statusline', description: 'Configure which items appear in the status line', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'collab', description: 'Change collaboration mode', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'files', description: 'Mention a file', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },

  // --- Stream commands ---
  { name: 'compact', description: 'Compact conversation history', aliases: [], subCommands: [], availability: 'supported', execution: 'stream', source: 'official', commandMode: 'session' },
  { name: 'review', description: 'Start a code review', aliases: [], subCommands: [], availability: 'supported', execution: 'stream', source: 'official', commandMode: 'prompt' },

  // --- Prompt commands ---
  { name: 'init', description: 'Initialize project', aliases: [], subCommands: [], availability: 'supported', execution: 'prompt', source: 'official', commandMode: 'prompt' },

  // --- Local UI commands ---
  { name: 'clear', description: 'Clear conversation display', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'fast', description: 'Switch to fast output mode', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'feedback', description: 'Send feedback', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'help', description: 'Show available commands', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'plan', description: 'Enter plan mode', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'version', description: 'Show CLI version', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'history', description: 'Browse conversation history', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'new', description: 'Start new session', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'resume', description: 'Resume a previous session', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'undo', description: 'Undo last changes', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'copy', description: 'Copy latest output to clipboard', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'rename', description: 'Rename the current thread', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'exit', description: 'Exit Codex', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'mode', description: 'Change approval mode', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },

  // --- CLI-only commands ---
  { name: 'search', description: 'Search conversations', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'config', description: 'View or edit config', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'theme', description: 'Change theme', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'login', description: 'Log in to Codex', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'logout', description: 'Log out of Codex', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'ide', description: 'Show IDE connection info', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'realtime', description: 'Toggle realtime voice mode', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'rollout', description: 'Print the rollout file path', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
  { name: 'clean', description: 'Stop all background terminals', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'clear-memories', description: 'Reset local memory state', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
  { name: 'sandbox-add-read-dir', description: 'Let sandbox read a directory', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session', argsHint: '<absolute-directory-path>' },
  { name: 'setup-default-sandbox', description: 'Set up elevated agent sandbox', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'session' },
];

// ---------------------------------------------------------------------------
// Gemini fallback commands
// ---------------------------------------------------------------------------

// Gemini commands are loaded dynamically via BuiltinCommandLoader.
// This fallback provides enrichment metadata for all known Gemini commands.
export const GEMINI_FALLBACK_COMMANDS: RuntimeCommandMetadata[] = [
  // --- Native controller commands (handled by gemini-native-controller.ts) ---
  { name: 'about', description: 'Show Gemini CLI version', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'mcp', description: 'Show MCP server status', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'mcp' },
  { name: 'permissions', description: 'View or change permissions', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'settings', description: 'Show Gemini settings', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'auth', description: 'Show authentication status', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'memory', description: 'View GEMINI.md files', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'agents', description: 'List configured agents', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'agent' },
  { name: 'extensions', description: 'Show extensions', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'hooks', description: 'List configured hooks', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'skills', description: 'List available skills', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'tools', description: 'List available tools', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'mcp' },
  { name: 'doctor', description: 'Check environment health', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'diff', description: 'Show git diff summary', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'model', description: 'View or change the current model', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session', argsHint: '[model-id]' },
  { name: 'init', description: 'Initialize GEMINI.md', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'profile', description: 'Show current profile', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'policies', description: 'View permissions (alias)', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },
  { name: 'rewind', description: 'Rewind recent changes', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'session' },

  // --- Prompt commands ---
  { name: 'compress', description: 'Compress conversation history', aliases: [], subCommands: [], availability: 'supported', execution: 'prompt', source: 'official', commandMode: 'session' },

  // --- Local UI commands ---
  { name: 'help', description: 'Show available commands', aliases: ['?'], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'clear', description: 'Clear conversation display', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'chat', description: 'Open chat panel', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'copy', description: 'Copy last response', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'quit', description: 'Exit the session', aliases: ['exit'], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'plan', description: 'Toggle plan mode', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'resume', description: 'Resume a previous session', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'stats', description: 'Show session statistics', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'commands', description: 'Show available commands', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'shortcuts', description: 'Show keyboard shortcuts', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'directory', description: 'Show working directory', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'corgi', description: 'Easter egg', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'docs', description: 'Open documentation', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'bug', description: 'Report a bug', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'privacy', description: 'Show privacy information', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'setup-github', description: 'Setup GitHub integration', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },

  // --- CLI-only commands ---
  { name: 'editor', description: 'Set default editor', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
  { name: 'ide', description: 'Show IDE connection info', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'shells', description: 'Configure shell integration', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
  { name: 'theme', description: 'Change color theme', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'login', description: 'Log in to Gemini', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'logout', description: 'Log out of Gemini', aliases: [], subCommands: [], availability: 'supported', execution: 'immediate', source: 'official', commandMode: 'local' },
  { name: 'vim', description: 'Toggle vim keybindings', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
  { name: 'terminal-setup', description: 'Setup terminal integration', aliases: [], subCommands: [], availability: 'cli-only', execution: 'cli-only', source: 'official', commandMode: 'local' },
];

// ---------------------------------------------------------------------------
// Lookup helper
// ---------------------------------------------------------------------------

export type { RuntimeCommandMetadata };

export function getFallbackCommands(engineType: string): RuntimeCommandMetadata[] {
  switch (engineType) {
    case 'codex':
      return CODEX_FALLBACK_COMMANDS;
    case 'gemini':
      return GEMINI_FALLBACK_COMMANDS;
    default:
      return CLAUDE_FALLBACK_COMMANDS;
  }
}
