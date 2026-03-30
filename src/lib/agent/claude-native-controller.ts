import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getConversation } from '@/lib/conversation-registry';
import { getClaudeModelsCached } from '@/lib/claude-model-discovery';
import { ensureClaudePersistentRuntime } from '@/lib/claude-persistent-client';
import { readRuntimeMcpServers } from '@/lib/runtime-config';
import { syncConfigToFile } from '@/lib/config-sync';
import type {
  AccountInfo,
  McpServerStatus,
  ModelInfo,
  PermissionMode,
  Query,
  RewindFilesResult,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type { NativeCommandControllerRequest, NativeCommandControllerResponse } from '@/types';
import { createSession, cloneSessionConversation, getSession } from '@/lib/db';

export type ClaudeNativeControlAction =
  | 'supportedCommands'
  | 'supportedModels'
  | 'setModel'
  | 'setPermissionMode'
  | 'mcpServerStatus'
  | 'rewindFiles'
  | 'initializationResult'
  | 'accountInfo';

export type ClaudeInitializationResult = Awaited<ReturnType<Query['initializationResult']>>;

export interface ClaudeNativeConversationHandle {
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  initializationResult(): Promise<ClaudeInitializationResult>;
  accountInfo(): Promise<AccountInfo>;
}

export type ClaudeNativeControlRequest =
  | { sessionId: string; action: 'supportedCommands' }
  | { sessionId: string; action: 'supportedModels' }
  | { sessionId: string; action: 'setModel'; model?: string }
  | { sessionId: string; action: 'setPermissionMode'; permissionMode: PermissionMode }
  | { sessionId: string; action: 'mcpServerStatus' }
  | { sessionId: string; action: 'rewindFiles'; userMessageId: string; dryRun?: boolean }
  | { sessionId: string; action: 'initializationResult' }
  | { sessionId: string; action: 'accountInfo' };

export class ClaudeNativeControlError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const execFileAsync = promisify(execFile);

const NATIVE_COMMAND_NAMES = new Set([
  'model', 'permissions', 'status', 'mcp',
  'doctor', 'memory', 'agents', 'pr_comments', 'diff',
  'fork', 'undo',
]);

const PERMISSION_MODE_ALIASES: Record<string, PermissionMode> = {
  default: 'default',
  ask: 'default',
  acceptedits: 'acceptEdits',
  'accept-edits': 'acceptEdits',
  code: 'acceptEdits',
  plan: 'plan',
  bypasspermissions: 'bypassPermissions',
  bypass: 'bypassPermissions',
  dontask: 'dontAsk',
  'dont-ask': 'dontAsk',
};

function toMarkdownCode(value: string): string {
  return `\`${value}\``;
}

function formatMode(mode: PermissionMode): string {
  if (mode === 'acceptEdits') return 'acceptEdits (code mode)';
  if (mode === 'bypassPermissions') return 'bypassPermissions';
  if (mode === 'dontAsk') return 'dontAsk';
  return mode;
}

function inferUiModeFromPermissionMode(mode: PermissionMode): 'code' | 'plan' | 'ask' {
  if (mode === 'plan') return 'plan';
  if (mode === 'default') return 'ask';
  return 'code';
}

function parsePermissionMode(input: string): PermissionMode | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  return PERMISSION_MODE_ALIASES[normalized] ?? null;
}

function formatModelStatusMessage(
  activeModel: string | undefined,
  models: ModelInfo[],
  context?: { reasoningEffort?: string; mode?: string },
): string {
  const lines: string[] = ['## Claude Model Status'];
  lines.push('');
  lines.push(`Current model: ${toMarkdownCode(activeModel || '(unknown)')}`);
  lines.push(`Reasoning effort: ${toMarkdownCode(context?.reasoningEffort || 'default')}`);
  lines.push(`Approval strategy: ${toMarkdownCode(context?.mode || 'code')}`);
  lines.push('');
  if (models.length === 0) {
    lines.push('No model list returned by runtime.');
    return lines.join('\n');
  }
  lines.push('Available models:');
  for (const model of models) {
    const extras: string[] = [];
    if (model.supportsEffort && model.supportedEffortLevels?.length) {
      extras.push(`effort: ${model.supportedEffortLevels.join(', ')}`);
    }
    if (model.supportsAdaptiveThinking) {
      extras.push('adaptive thinking');
    }
    const suffix = extras.length > 0 ? ` (${extras.join(' | ')})` : '';
    lines.push(`- ${toMarkdownCode(model.value)} — ${model.displayName}${suffix}`);
  }
  return lines.join('\n');
}

function formatMcpStatusMessage(statuses: McpServerStatus[]): string {
  const lines: string[] = ['## MCP Server Status'];
  lines.push('');
  if (statuses.length === 0) {
    lines.push('No MCP servers reported by runtime.');
    return lines.join('\n');
  }
  for (const server of statuses) {
    const error = server.error ? ` — ${server.error}` : '';
    lines.push(`- ${toMarkdownCode(server.name)}: ${server.status}${error}`);
  }
  return lines.join('\n');
}

function getHandle(sessionId: string): ClaudeNativeConversationHandle {
  const candidate = (
    getConversation(sessionId)
    || ensureClaudePersistentRuntime(sessionId)
  ) as unknown as Partial<ClaudeNativeConversationHandle> | undefined;

  if (!candidate) {
    throw new ClaudeNativeControlError(
      409,
      'NO_ACTIVE_RUNTIME',
      'No active Claude runtime found for this session. Start streaming first.',
    );
  }

  return candidate as ClaudeNativeConversationHandle;
}

function assertMethod<K extends keyof ClaudeNativeConversationHandle>(
  handle: ClaudeNativeConversationHandle,
  method: K,
): asserts handle is ClaudeNativeConversationHandle & Required<Pick<ClaudeNativeConversationHandle, K>> {
  if (typeof handle[method] !== 'function') {
    throw new ClaudeNativeControlError(
      501,
      'UNSUPPORTED_CONTROL_METHOD',
      `Active runtime does not expose control method: ${String(method)}`,
    );
  }
}

export async function runClaudeNativeControl(request: ClaudeNativeControlRequest): Promise<unknown> {
  const handle = getHandle(request.sessionId);

  switch (request.action) {
    case 'supportedCommands': {
      assertMethod(handle, 'supportedCommands');
      return handle.supportedCommands();
    }
    case 'supportedModels': {
      assertMethod(handle, 'supportedModels');
      return handle.supportedModels();
    }
    case 'setModel': {
      assertMethod(handle, 'setModel');
      await handle.setModel(request.model);
      return { applied: true, model: request.model ?? null };
    }
    case 'setPermissionMode': {
      assertMethod(handle, 'setPermissionMode');
      await handle.setPermissionMode(request.permissionMode);
      return { applied: true, permissionMode: request.permissionMode };
    }
    case 'mcpServerStatus': {
      assertMethod(handle, 'mcpServerStatus');
      return handle.mcpServerStatus();
    }
    case 'rewindFiles': {
      assertMethod(handle, 'rewindFiles');
      return handle.rewindFiles(request.userMessageId, { dryRun: request.dryRun });
    }
    case 'initializationResult': {
      assertMethod(handle, 'initializationResult');
      return handle.initializationResult();
    }
    case 'accountInfo': {
      assertMethod(handle, 'accountInfo');
      return handle.accountInfo();
    }
    default: {
      const neverAction: never = request;
      throw new ClaudeNativeControlError(400, 'UNKNOWN_ACTION', `Unsupported action: ${String(neverAction)}`);
    }
  }
}

/**
 * Persist a Claude permission mode to ~/.claude/settings.json so the
 * change survives across sessions and CLI restarts.
 */


export async function runClaudeNativeCommand(
  request: NativeCommandControllerRequest,
): Promise<NativeCommandControllerResponse> {
  const commandName = request.command_name.trim().toLowerCase();
  const sessionId = request.session_id?.trim() || '';
  const args = request.args?.trim() || '';

  if (!NATIVE_COMMAND_NAMES.has(commandName)) {
    return {
      handled: false,
      message: `Unsupported native command: /${commandName}`,
      error: 'UNSUPPORTED_NATIVE_COMMAND',
    };
  }

  if (request.engine_type !== 'claude') {
    return {
      handled: false,
      message: `Native Claude controller is unavailable for engine "${request.engine_type}".`,
      error: 'UNSUPPORTED_ENGINE',
    };
  }

  // Commands that do NOT require an active SDK session
  const SESSION_FREE_COMMANDS = new Set(['doctor', 'memory', 'agents', 'pr_comments', 'diff']);

  try {
    if (commandName === 'model') {
      if (!args) {
        let models: ModelInfo[];
        if (sessionId) {
          try {
            models = await runClaudeNativeControl({
              sessionId,
              action: 'supportedModels',
            }) as ModelInfo[];
          } catch (fallbackErr) {
            if (fallbackErr instanceof ClaudeNativeControlError && fallbackErr.code === 'NO_ACTIVE_RUNTIME') {
              // Prefer SDK-cached models, then provider config fallback
              const cached = getClaudeModelsCached();
              models = cached.map(m => ({
                value: m.value,
                displayName: m.label,
                description: '',
                supportedEffortLevels: m.reasoning_efforts as ModelInfo['supportedEffortLevels'],
                supportsEffort: !!(m.reasoning_efforts && m.reasoning_efforts.length > 0),
              }));
            } else {
              throw fallbackErr;
            }
          }
        } else {
          // No session yet — prefer SDK cache, then provider config
          const cached = getClaudeModelsCached();
          models = cached.map(m => ({
            value: m.value,
            displayName: m.label,
            description: '',
            supportedEffortLevels: m.reasoning_efforts as ModelInfo['supportedEffortLevels'],
            supportsEffort: !!(m.reasoning_efforts && m.reasoning_efforts.length > 0),
          }));
        }
        return {
          handled: true,
          message: formatModelStatusMessage(request.context?.model, models, {
            reasoningEffort: request.context?.reasoning_effort,
            mode: request.context?.mode,
          }),
          data: {
            active_model: request.context?.model || null,
            reasoning_effort: request.context?.reasoning_effort || null,
            approval_strategy: request.context?.mode || null,
            models,
          },
        };
      }

      if (sessionId) {
        try {
          await runClaudeNativeControl({
            sessionId,
            action: 'setModel',
            model: args,
          });
        } catch (err) {
          // Runtime not active yet — fall through to state_patch
          if (!(err instanceof ClaudeNativeControlError && err.code === 'NO_ACTIVE_RUNTIME')) {
            throw err;
          }
        }
      }

      return {
        handled: true,
        message: `Model switched to ${toMarkdownCode(args)}.`,
        state_patch: { model: args },
        data: { model: args },
      };
    }

    if (commandName === 'permissions') {
      if (!args) {
        const modes: PermissionMode[] = ['acceptEdits', 'plan', 'default', 'bypassPermissions', 'dontAsk'];
        return {
          handled: true,
          message: [
            '## Claude Permission Mode',
            '',
            'Use:',
            '- `/permissions code` → acceptEdits',
            '- `/permissions plan`',
            '- `/permissions ask` → default',
            '- `/permissions bypass`',
            '- `/permissions dontAsk`',
            '',
            `Current UI mode hint: ${toMarkdownCode(request.context?.mode || '(unknown)')}`,
            `Supported modes: ${modes.map((mode) => toMarkdownCode(mode)).join(', ')}`,
          ].join('\n'),
          data: {
            supported_permission_modes: modes,
            current_mode: request.context?.mode || null,
          },
        };
      }

      const permissionMode = parsePermissionMode(args);
      if (!permissionMode) {
        return {
          handled: true,
          message: `Unknown permission mode ${toMarkdownCode(args)}. Try ${toMarkdownCode('/permissions plan')} or ${toMarkdownCode('/permissions code')}.`,
          error: 'INVALID_PERMISSION_MODE',
        };
      }

      if (sessionId) {
        try {
          await runClaudeNativeControl({
            sessionId,
            action: 'setPermissionMode',
            permissionMode,
          });
        } catch (err) {
          if (!(err instanceof ClaudeNativeControlError && err.code === 'NO_ACTIVE_RUNTIME')) {
            throw err;
          }
        }
      }

      // Persist to ~/.claude/settings.json so the mode survives across sessions
      syncConfigToFile('claude', { mode: permissionMode });

      return {
        handled: true,
        message: `Permission mode switched to ${toMarkdownCode(formatMode(permissionMode))}.`,
        state_patch: {
          mode: inferUiModeFromPermissionMode(permissionMode),
        },
        data: {
          permission_mode: permissionMode,
        },
      };
    }

    if (commandName === 'mcp') {
      if (sessionId) {
        try {
          const statuses = await runClaudeNativeControl({
            sessionId,
            action: 'mcpServerStatus',
          }) as McpServerStatus[];
          return {
            handled: true,
            message: formatMcpStatusMessage(statuses),
            data: { mcp_servers: statuses },
          };
        } catch (err) {
          if (!(err instanceof ClaudeNativeControlError && err.code === 'NO_ACTIVE_RUNTIME')) {
            throw err;
          }
          // Fall through to config-based listing
        }
      }
      // No runtime — show MCP servers from config
      const { mcpServers } = readRuntimeMcpServers('claude');
      const names = Object.keys(mcpServers);
      return {
        handled: true,
        message: names.length > 0
          ? ['## MCP Server Status', '', ...names.map(n => `- ${toMarkdownCode(n)}: (runtime not active)`)].join('\n')
          : '## MCP Server Status\n\nNo MCP servers configured.',
      };
    }

    if (commandName === 'status') {
      if (sessionId) {
        try {
          const [init, mcpStatuses, account] = await Promise.all([
            runClaudeNativeControl({ sessionId, action: 'initializationResult' }) as Promise<ClaudeInitializationResult>,
            runClaudeNativeControl({ sessionId, action: 'mcpServerStatus' }) as Promise<McpServerStatus[]>,
            runClaudeNativeControl({ sessionId, action: 'accountInfo' }).catch(() => null) as Promise<AccountInfo | null>,
          ]);
          const connectedMcpCount = mcpStatuses.filter((item) => item.status === 'connected').length;

          const accountLines: string[] = [];
          if (account) {
            if (account.email) accountLines.push(`Account: ${toMarkdownCode(account.email)}`);
            if (account.organization) accountLines.push(`Organization: ${toMarkdownCode(account.organization)}`);
            if (account.subscriptionType) accountLines.push(`Plan: ${toMarkdownCode(account.subscriptionType)}`);
          }

          return {
            handled: true,
            message: [
              '## Claude Runtime Status',
              '',
              `Session: ${toMarkdownCode(sessionId)}`,
              `Model (UI): ${toMarkdownCode(request.context?.model || '(unknown)')}`,
              `Mode (UI): ${toMarkdownCode(request.context?.mode || '(unknown)')}`,
              ...accountLines,
              `Available slash commands: ${toMarkdownCode(String(init.commands.length))}`,
              `Available models: ${toMarkdownCode(String(init.models.length))}`,
              `MCP connected: ${toMarkdownCode(`${connectedMcpCount}/${mcpStatuses.length}`)}`,
            ].join('\n'),
            data: {
              initialization: init,
              mcp_servers: mcpStatuses,
              account,
            },
          };
        } catch (err) {
          if (!(err instanceof ClaudeNativeControlError && err.code === 'NO_ACTIVE_RUNTIME')) {
            throw err;
          }
          // Fall through to basic UI status
        }
      }
      return {
        handled: true,
        message: [
          '## Claude Runtime Status',
          '',
          `Session: ${toMarkdownCode(sessionId || '(none)')}`,
          `Model (UI): ${toMarkdownCode(request.context?.model || '(unknown)')}`,
          `Mode (UI): ${toMarkdownCode(request.context?.mode || '(unknown)')}`,
          '',
          '_No active runtime. Send a message to start a session._',
        ].join('\n'),
      };
    }

    // For remaining commands that need an active session, check sessionId
    if (!sessionId && !SESSION_FREE_COMMANDS.has(commandName)) {
      return {
        handled: false,
        message: 'No active session. Send a message first to start a session.',
        error: 'MISSING_SESSION_ID',
      };
    }

    if (commandName === 'doctor') {
      const claudeDir = path.join(os.homedir(), '.claude');
      const hasClaudeDir = fs.existsSync(claudeDir);
      const { mcpServers } = readRuntimeMcpServers('claude');
      const mcpCount = Object.keys(mcpServers).length;
      let sdkInfo = '(no active session)';
      let accountInfo = '';
      try {
        const [init, account] = await Promise.all([
          runClaudeNativeControl({ sessionId, action: 'initializationResult' }) as Promise<ClaudeInitializationResult>,
          runClaudeNativeControl({ sessionId, action: 'accountInfo' }).catch(() => null) as Promise<AccountInfo | null>,
        ]);
        sdkInfo = `${init.commands.length} commands, ${init.models.length} models`;
        if (account?.email) accountInfo = account.email;
        if (account?.subscriptionType) accountInfo += ` (${account.subscriptionType})`;
      } catch { /* session may not be active */ }
      return {
        handled: true,
        message: [
          '## Claude Health Check',
          '',
          `- Config directory: ${hasClaudeDir ? '✓' : '✗'} ${toMarkdownCode(claudeDir)}`,
          `- MCP servers: ${mcpCount}`,
          `- SDK runtime: ${sdkInfo}`,
          accountInfo ? `- Account: ${toMarkdownCode(accountInfo)}` : null,
          `- Model (UI): ${toMarkdownCode(request.context?.model || '(unknown)')}`,
          `- Mode (UI): ${toMarkdownCode(request.context?.mode || '(unknown)')}`,
        ].filter(Boolean).join('\n'),
      };
    }

    if (commandName === 'memory') {
      const files: Array<{ path: string; content: string }> = [];
      const globalPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
      if (fs.existsSync(globalPath)) {
        try { files.push({ path: globalPath, content: fs.readFileSync(globalPath, 'utf-8') }); } catch { /* skip */ }
      }
      const workDir = request.context?.working_directory;
      if (workDir) {
        const projectPath = path.join(workDir, 'CLAUDE.md');
        if (fs.existsSync(projectPath)) {
          try { files.push({ path: projectPath, content: fs.readFileSync(projectPath, 'utf-8') }); } catch { /* skip */ }
        }
      }
      if (files.length === 0) {
        return { handled: true, message: '## Claude Memory\n\nNo CLAUDE.md files found. Use `/init` to create one.' };
      }
      const sections = files.map(f => `### ${toMarkdownCode(f.path)}\n\n${f.content}`);
      return {
        handled: true,
        message: ['## Claude Memory', '', ...sections].join('\n'),
        data: { files: files.map(f => f.path) },
      };
    }

    if (commandName === 'agents') {
      const workDir = request.context?.working_directory;
      const agentsDir = workDir ? path.join(workDir, '.claude', 'agents') : null;
      const items: string[] = [];
      if (agentsDir && fs.existsSync(agentsDir)) {
        try {
          items.push(...fs.readdirSync(agentsDir).filter(f => !f.startsWith('.')));
        } catch { /* skip */ }
      }
      return {
        handled: true,
        message: items.length > 0
          ? ['## Claude Agents', '', ...items.map(a => `- ${toMarkdownCode(a)}`)].join('\n')
          : '## Claude Agents\n\nNo agents found in `.claude/agents/`.',
      };
    }

    if (commandName === 'pr_comments') {
      const workDir = request.context?.working_directory || process.cwd();
      try {
        const { stdout } = await execFileAsync('gh', ['pr', 'view', '--json', 'number,title,url,comments', '--jq', '.number,.title,.url,.comments[].body'], {
          cwd: workDir,
          timeout: 15000,
        });
        const output = stdout.trim();
        return {
          handled: true,
          message: output
            ? ['## PR Comments', '', output].join('\n')
            : '## PR Comments\n\nNo comments found (or no open PR for this branch).',
        };
      } catch {
        return {
          handled: true,
          message: '## PR Comments\n\nFailed to fetch PR comments. Ensure `gh` CLI is installed and authenticated.',
        };
      }
    }

    if (commandName === 'diff') {
      const workDir = request.context?.working_directory || process.cwd();
      try {
        const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD'], {
          cwd: workDir,
          timeout: 10000,
        });
        const diffOutput = stdout.trim();
        return {
          handled: true,
          message: diffOutput
            ? ['## Git Diff', '', '```', diffOutput, '```'].join('\n')
            : '## Git Diff\n\nNo changes detected.',
        };
      } catch {
        return { handled: true, message: '## Git Diff\n\nFailed to run `git diff`. Is this a git repository?' };
      }
    }

    if (commandName === 'fork') {
      if (!request.session_id) {
        return {
          handled: false,
          message: 'Claude `/fork` requires an active conversation.',
          error: 'SESSION_REQUIRED',
        };
      }
      const sourceSession = getSession(request.session_id);
      if (!sourceSession) {
        return {
          handled: false,
          message: 'Could not find the current session to fork.',
          error: 'SESSION_NOT_FOUND',
        };
      }

      const forkedTitle = (sourceSession.title || 'New Chat').replace(/\s*\(fork\)$/i, '') + ' (fork)';
      const forkedSession = createSession(
        forkedTitle,
        sourceSession.model || request.context?.model || undefined,
        sourceSession.reasoning_effort || undefined,
        sourceSession.system_prompt || '',
        sourceSession.working_directory || request.context?.working_directory || '',
        sourceSession.mode || request.context?.mode || 'code',
        sourceSession.provider_id || 'anthropic',
        'claude',
        undefined,
      );
      const clonedCount = cloneSessionConversation(sourceSession.id, forkedSession.id);

      return {
        handled: true,
        message: `Forked the current conversation into ${toMarkdownCode(forkedTitle)}.`,
        data: {
          new_session_id: forkedSession.id,
          title: forkedTitle,
          model: sourceSession.model,
          working_directory: sourceSession.working_directory,
          cloned_message_count: typeof clonedCount === 'number' ? clonedCount : null,
        },
      };
    }

    if (commandName === 'undo') {
      if (!sessionId) {
        return {
          handled: false,
          message: 'Claude `/undo` requires an active session. Send a message first.',
          error: 'MISSING_SESSION_ID',
        };
      }
      try {
        const handle = getHandle(sessionId);
        assertMethod(handle, 'rewindFiles');
        // First do a dry run to preview what will be undone
        const dryResult = await handle.rewindFiles('', { dryRun: true });
        if (!dryResult || !dryResult.canRewind) {
          return {
            handled: true,
            message: '## Undo\n\n' + (dryResult?.error || 'No file changes to rewind.'),
          };
        }
        // Perform the actual rewind
        const result = await handle.rewindFiles('');
        if (!result.canRewind) {
          return {
            handled: true,
            message: '## Undo\n\n' + (result.error || 'Could not rewind files.'),
          };
        }
        const lines = ['## Undo — Files Rewound', ''];
        if (result.filesChanged?.length) {
          lines.push('**Changed files:**');
          for (const f of result.filesChanged) {
            lines.push('- ' + toMarkdownCode(f));
          }
        }
        if (typeof result.insertions === 'number' || typeof result.deletions === 'number') {
          lines.push('');
          lines.push('**Stats:** ' + (result.insertions || 0) + ' insertion(s), ' + (result.deletions || 0) + ' deletion(s).');
        }
        return {
          handled: true,
          message: lines.join('\n'),
          data: result,
        };
      } catch (err) {
        if (err instanceof ClaudeNativeControlError && err.code === 'NO_ACTIVE_RUNTIME') {
          return {
            handled: true,
            message: '## Undo\n\nNo active Claude runtime. Send a message first to start a session.',
          };
        }
        if (err instanceof ClaudeNativeControlError && err.code === 'UNSUPPORTED_CONTROL_METHOD') {
          return {
            handled: true,
            message: '## Undo\n\nThe current Claude runtime does not support file rewind.',
          };
        }
        throw err;
      }
    }

    return {
      handled: false,
      message: `Unsupported native command: /${commandName}`,
      error: 'UNSUPPORTED_NATIVE_COMMAND',
    };
  } catch (error) {
    if (error instanceof ClaudeNativeControlError) {
      return {
        handled: false,
        message: error.message,
        error: error.code,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: false,
      message: message || 'Native command failed',
      error: 'NATIVE_COMMAND_FAILED',
    };
  }
}
