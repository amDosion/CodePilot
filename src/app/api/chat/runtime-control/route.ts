import { NextRequest, NextResponse } from 'next/server';
import type { McpServerStatus, ModelInfo, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeNativeControlError,
  type ClaudeNativeControlAction,
  type ClaudeNativeControlRequest,
  runClaudeNativeControl,
} from '@/lib/agent/claude-native-controller';
import { resolveEngineType } from '@/lib/agent/engine-resolver';
import { syncConfigToFile } from '@/lib/config-sync';
import { getSession } from '@/lib/db';
import type {
  NativeCommandControllerRequest,
  NativeCommandControllerRequestContext,
  NativeCommandControllerResponse,
  NativeCommandStatePatch,
} from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLAUDE_NATIVE_COMMANDS = new Set(['model', 'permissions', 'status', 'mcp']);
const LEGACY_ACTIONS: ClaudeNativeControlAction[] = [
  'supportedCommands',
  'supportedModels',
  'setModel',
  'setPermissionMode',
  'mcpServerStatus',
  'rewindFiles',
  'initializationResult',
  'accountInfo',
];
const LEGACY_PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeCommandName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^\//, '').toLowerCase();
}

function parseRequest(body: Record<string, unknown>): NativeCommandControllerRequest | null {
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  const commandName = normalizeCommandName(body.command_name || command);
  const engineType = typeof body.engine_type === 'string' ? body.engine_type.trim() : '';

  if (!commandName || !engineType) {
    return null;
  }

  const context = isRecord(body.context)
    ? body.context as NativeCommandControllerRequestContext
    : undefined;

  return {
    session_id: typeof body.session_id === 'string' ? body.session_id.trim() : undefined,
    engine_type: engineType,
    command,
    command_name: commandName,
    args: typeof body.args === 'string' ? body.args.trim() : undefined,
    context,
  };
}

function parseLegacyAction(value: unknown): ClaudeNativeControlAction | null {
  if (typeof value !== 'string') return null;
  return LEGACY_ACTIONS.includes(value as ClaudeNativeControlAction)
    ? (value as ClaudeNativeControlAction)
    : null;
}

function parseLegacyPermissionMode(value: unknown): PermissionMode | null {
  if (typeof value !== 'string') return null;
  return LEGACY_PERMISSION_MODES.includes(value as PermissionMode)
    ? (value as PermissionMode)
    : null;
}

function buildLegacyRequest(body: Record<string, unknown>): ClaudeNativeControlRequest | { error: string } {
  const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
  if (!sessionId) {
    return { error: 'session_id is required' };
  }

  const action = parseLegacyAction(body.action);
  if (!action) {
    return { error: 'Invalid or missing action' };
  }

  switch (action) {
    case 'supportedCommands':
    case 'supportedModels':
    case 'mcpServerStatus':
    case 'initializationResult':
    case 'accountInfo':
      return { sessionId, action };
    case 'setModel':
      return {
        sessionId,
        action,
        model: typeof body.model === 'string' ? body.model : undefined,
      };
    case 'setPermissionMode': {
      const permissionMode = parseLegacyPermissionMode(body.permission_mode);
      if (!permissionMode) {
        return { error: `permission_mode must be one of: ${LEGACY_PERMISSION_MODES.join(', ')}` };
      }
      return { sessionId, action, permissionMode };
    }
    case 'rewindFiles': {
      const userMessageId = typeof body.user_message_id === 'string' ? body.user_message_id.trim() : '';
      if (!userMessageId) {
        return { error: 'user_message_id is required for rewindFiles' };
      }
      if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
        return { error: 'dry_run must be a boolean when provided' };
      }
      return {
        sessionId,
        action,
        userMessageId,
        dryRun: typeof body.dry_run === 'boolean' ? body.dry_run : undefined,
      };
    }
  }
}

function json(
  body: NativeCommandControllerResponse,
  status = 200,
): NextResponse<NativeCommandControllerResponse> {
  return NextResponse.json(body, { status });
}

function mapPermissionModeToUiMode(mode: PermissionMode): 'code' | 'plan' | 'ask' {
  if (mode === 'plan') return 'plan';
  if (mode === 'default') return 'ask';
  return 'code';
}

function parsePermissionModeArg(args?: string): PermissionMode | null {
  const normalized = (args || '').trim().toLowerCase();
  if (!normalized) return null;

  const firstToken = normalized.split(/\s+/)[0];
  switch (firstToken) {
    case 'ask':
    case 'default':
      return 'default';
    case 'code':
    case 'edit':
    case 'edits':
    case 'accept':
    case 'acceptedits':
    case 'accept-edits':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'bypass':
    case 'bypasspermissions':
    case 'bypass-permissions':
      return 'bypassPermissions';
    case 'dontask':
    case 'dont-ask':
      return 'dontAsk';
    default:
      return null;
  }
}

function formatModelList(models: ModelInfo[], currentModel?: string): string {
  if (models.length === 0) {
    return 'Claude runtime did not report any available models.';
  }

  const lines = models.map((model) => {
    const current = currentModel === model.value ? ' (current)' : '';
    const effortSuffix = model.supportsEffort && model.supportedEffortLevels?.length
      ? ` | effort: ${model.supportedEffortLevels.join(', ')}`
      : '';
    return `- \`${model.value}\` — ${model.displayName}${current}${effortSuffix}`;
  });

  return [
    '## Claude Runtime Model Selection',
    currentModel ? `Current model: \`${currentModel}\`` : null,
    '',
    ...lines,
    '',
    'Use `/model <model-id>` to switch the active Claude runtime model.',
  ].filter(Boolean).join('\n');
}

function formatPermissionStatus(context: NativeCommandControllerRequestContext | undefined): string {
  const currentMode = context?.mode || 'code';

  return [
    '## Claude Runtime Permission Mode',
    `Current GUI mode: \`${currentMode}\``,
    '',
    '- `/permissions ask` → ask before edits',
    '- `/permissions code` → accept edits',
    '- `/permissions plan` → plan mode',
    '- `/permissions bypass` → bypass permissions',
    '- `/permissions dont-ask` → do not ask',
  ].join('\n');
}

function formatMcpStatus(servers: McpServerStatus[]): string {
  if (servers.length === 0) {
    return '## Claude MCP Servers\n\nNo MCP servers are currently reported by the active Claude runtime.';
  }

  const lines = servers.map((server) => {
    const version = server.serverInfo?.version ? ` v${server.serverInfo.version}` : '';
    const tools = server.tools?.length ? ` | tools: ${server.tools.length}` : '';
    const error = server.error ? ` | error: ${server.error}` : '';
    return `- \`${server.name}\` — ${server.status}${version}${tools}${error}`;
  });

  return ['## Claude MCP Servers', '', ...lines].join('\n');
}

function formatStatusSummary(options: {
  model?: string;
  mode?: string;
  initialization: Awaited<ReturnType<typeof runClaudeNativeControl>>;
  mcpServers: McpServerStatus[];
  sessionId: string;
}): string {
  const initialization = options.initialization as {
    account?: { email?: string; organization?: string; subscriptionType?: string };
    output_style?: string;
    available_output_styles?: string[];
    commands?: Array<{ name: string }>;
    models?: ModelInfo[];
  };

  const accountLine = initialization.account?.email
    ? `- Account: \`${initialization.account.email}\``
    : null;
  const orgLine = initialization.account?.organization
    ? `- Organization: \`${initialization.account.organization}\``
    : null;
  const subscriptionLine = initialization.account?.subscriptionType
    ? `- Subscription: \`${initialization.account.subscriptionType}\``
    : null;
  const outputLine = initialization.output_style
    ? `- Output style: \`${initialization.output_style}\``
    : null;
  const outputStylesLine = initialization.available_output_styles?.length
    ? `- Available output styles: ${initialization.available_output_styles.map((style) => `\`${style}\``).join(', ')}`
    : null;
  const commandsLine = initialization.commands?.length
    ? `- Native slash commands: ${initialization.commands.map((command) => `\`/${command.name}\``).join(', ')}`
    : null;
  const modelsLine = initialization.models?.length
    ? `- Native models: ${initialization.models.map((model) => `\`${model.value}\``).join(', ')}`
    : null;

  return [
    '## Claude Runtime Status',
    `- Session: \`${options.sessionId}\``,
    options.model ? `- Active model: \`${options.model}\`` : null,
    options.mode ? `- GUI mode: \`${options.mode}\`` : null,
    accountLine,
    orgLine,
    subscriptionLine,
    outputLine,
    outputStylesLine,
    commandsLine,
    modelsLine,
    `- MCP servers: ${options.mcpServers.length}`,
  ].filter(Boolean).join('\n');
}

function controlErrorToResponse(error: ClaudeNativeControlError): {
  status: number;
  body: NativeCommandControllerResponse;
} {
  const message = error.code === 'NO_ACTIVE_RUNTIME'
    ? 'Claude native control requires an active runtime handle. Send a message in this session first.'
    : error.message;

  return {
    status: error.status,
    body: {
      handled: false,
      message,
      error: error.code,
    },
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!isRecord(body)) {
      return json({ handled: false, error: 'Request body must be an object' }, 400);
    }

    if (
      body.action !== undefined
      && body.command_name === undefined
      && body.command === undefined
      && body.engine_type === undefined
      && typeof body.session_id === 'string'
    ) {
      const parsedLegacy = buildLegacyRequest(body);
      if ('error' in parsedLegacy) {
        return NextResponse.json({ error: parsedLegacy.error }, { status: 400 });
      }

      const session = getSession(parsedLegacy.sessionId);
      if (!session) {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }

      const engineType = resolveEngineType({ session });
      if (engineType !== 'claude') {
        return NextResponse.json(
          { error: `Runtime control is currently supported only for Claude sessions (current: ${engineType})` },
          { status: 400 },
        );
      }

      const result = await runClaudeNativeControl(parsedLegacy);
      return NextResponse.json({
        ok: true,
        action: parsedLegacy.action,
        result,
      });
    }

    const parsed = parseRequest(body);
    if (!parsed) {
      return json({ handled: false, error: 'Invalid native command request' }, 400);
    }

    if (!CLAUDE_NATIVE_COMMANDS.has(parsed.command_name)) {
      return json({ handled: false, error: `Unsupported native command: /${parsed.command_name}` }, 400);
    }

    if (!parsed.session_id) {
      return json({
        handled: false,
        message: 'Claude native control requires an existing chat session. Send a first message before using this command.',
        error: 'SESSION_REQUIRED',
      }, 409);
    }

    const session = getSession(parsed.session_id);
    if (!session) {
      return json({ handled: false, error: 'Session not found' }, 404);
    }

    const engineType = resolveEngineType({ session, engine: parsed.engine_type });
    if (engineType !== 'claude') {
      return json({
        handled: false,
        error: `Native runtime control is currently available only for Claude sessions (current: ${engineType})`,
      }, 400);
    }

    let response: NativeCommandControllerResponse;
    switch (parsed.command_name) {
      case 'model': {
        if (parsed.args) {
          await runClaudeNativeControl({
            sessionId: parsed.session_id,
            action: 'setModel',
            model: parsed.args,
          });
          syncConfigToFile('claude', { model: parsed.args });

          const statePatch: NativeCommandStatePatch = { model: parsed.args };
          response = {
            handled: true,
            message: `Claude runtime model switched to \`${parsed.args}\`.`,
            state_patch: statePatch,
            data: { model: parsed.args },
          };
          break;
        }

        const models = await runClaudeNativeControl({
          sessionId: parsed.session_id,
          action: 'supportedModels',
        }) as ModelInfo[];

        response = {
          handled: true,
          message: formatModelList(models, parsed.context?.model || session.model),
          data: { models },
        };
        break;
      }
      case 'permissions': {
        const permissionMode = parsePermissionModeArg(parsed.args);
        if (!parsed.args || !permissionMode) {
          response = {
            handled: true,
            message: formatPermissionStatus(parsed.context),
            data: { current_mode: parsed.context?.mode || session.mode || 'code' },
          };
          break;
        }

        await runClaudeNativeControl({
          sessionId: parsed.session_id,
          action: 'setPermissionMode',
          permissionMode,
        });

        syncConfigToFile('claude', { mode: mapPermissionModeToUiMode(permissionMode) });

        const uiMode = mapPermissionModeToUiMode(permissionMode);
        response = {
          handled: true,
          message: `Claude runtime permission mode switched to \`${permissionMode}\`.`,
          state_patch: { mode: uiMode },
          data: { permission_mode: permissionMode },
        };
        break;
      }
      case 'mcp': {
        const mcpServers = await runClaudeNativeControl({
          sessionId: parsed.session_id,
          action: 'mcpServerStatus',
        }) as McpServerStatus[];

        response = {
          handled: true,
          message: formatMcpStatus(mcpServers),
          data: { mcp_servers: mcpServers },
        };
        break;
      }
      case 'status': {
        const initialization = await runClaudeNativeControl({
          sessionId: parsed.session_id,
          action: 'initializationResult',
        });
        const mcpServers = await runClaudeNativeControl({
          sessionId: parsed.session_id,
          action: 'mcpServerStatus',
        }) as McpServerStatus[];

        response = {
          handled: true,
          message: formatStatusSummary({
            sessionId: parsed.session_id,
            model: parsed.context?.model || session.model,
            mode: parsed.context?.mode || session.mode || undefined,
            initialization,
            mcpServers,
          }),
          data: {
            initialization,
            mcp_servers: mcpServers,
          },
        };
        break;
      }
      default:
        response = {
          handled: false,
          error: `Unsupported native command: /${parsed.command_name}`,
        };
    }

    return json(response);
  } catch (error) {
    if (error instanceof ClaudeNativeControlError) {
      const { status, body } = controlErrorToResponse(error);
      return json(body, status);
    }

    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[POST /api/chat/runtime-control] Error:', message);
    return json({ handled: false, error: 'Internal server error' }, 500);
  }
}
