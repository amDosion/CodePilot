import { execFile } from 'child_process';
import { promisify } from 'util';
import { cloneSessionConversation, createSession, getSession } from '@/lib/db';
import { normalizeReasoningEffort } from '@/lib/engine-defaults';
import type {
  CodexAppServerAccount,
  CodexAppServerClient,
  CodexAppServerConfig,
  CodexAppServerMcpServerStatus,
  CodexAppServerThread,
} from '@/lib/codex-app-server-client';
import { withCodexAppServer } from '@/lib/codex-app-server-client';
import { getCodexModelsCached } from '@/lib/codex-model-discovery';
import { normalizeCodexModelListPayload, type CodexModelOption } from '@/lib/codex-model-options';
import type { NativeCommandControllerRequest, NativeCommandControllerResponse, NativeCommandStatePatch } from '@/types';

const execFileAsync = promisify(execFile);

const NATIVE_COMMAND_NAMES = new Set([
  'model', 'status', 'mcp', 'fork',
  'permissions', 'diff', 'agent', 'experimental', 'personality', 'ps', 'debug-config',
  'skills', 'apps', 'undo',
]);

type WithCodexAppServer = typeof withCodexAppServer;

type RunnerDeps = {
  withCodexAppServer: WithCodexAppServer;
  getSession: typeof getSession;
  createSession: typeof createSession;
  cloneSessionConversation: typeof cloneSessionConversation;
  getCodexModelsCached: typeof getCodexModelsCached;
};

function toMarkdownCode(value: string): string {
  return `\`${value}\``;
}

function buildForkedSessionTitle(sourceTitle?: string | null, runtimeName?: string | null): string {
  const baseTitle = (runtimeName || sourceTitle || 'New Chat').trim() || 'New Chat';
  return /\(fork\)$/i.test(baseTitle)
    ? baseTitle
    : baseTitle + ' (fork)';
}

function formatCodexModelList(
  models: CodexModelOption[],
  currentModel?: string,
  currentEffort?: string,
): string {
  if (models.length === 0) {
    return 'Codex runtime did not report any available models.';
  }

  const lines = models.map((model) => {
    const current = currentModel === model.value ? ' (current)' : '';
    const effortSuffix = model.reasoning_efforts?.length
      ? ` | effort: ${model.reasoning_efforts.join(', ')}`
      : '';
    return `- ${toMarkdownCode(model.value)} — ${model.label}${current}${effortSuffix}`;
  });

  return [
    '## Codex Runtime Model Selection',
    currentModel ? `Current model: ${toMarkdownCode(currentModel)}` : null,
    currentEffort ? `Current reasoning effort: ${toMarkdownCode(currentEffort)}` : null,
    '',
    ...lines,
    '',
    'Use `/model <model-id> [reasoning-effort]` to update the active Codex model.',
  ].filter(Boolean).join('\n');
}

function formatCodexMcpStatus(servers: CodexAppServerMcpServerStatus[]): string {
  if (servers.length === 0) {
    return '## Codex MCP Servers\n\nNo MCP servers are currently reported by the Codex runtime.';
  }

  const lines = servers.map((server) => {
    const toolCount = server.tools ? Object.keys(server.tools).length : 0;
    const resourceCount = server.resources?.length || 0;
    const templateCount = server.resourceTemplates?.length || 0;
    return [
      `- ${toMarkdownCode(server.name)}`,
      `auth: ${server.authStatus || 'unknown'}`,
      `tools: ${toolCount}`,
      `resources: ${resourceCount}`,
      `templates: ${templateCount}`,
    ].join(' | ');
  });

  return ['## Codex MCP Servers', '', ...lines].join('\n');
}

function formatCodexAccount(account: CodexAppServerAccount | null, requiresOpenaiAuth: boolean): string[] {
  if (!account) {
    return [
      `- Auth required: ${requiresOpenaiAuth ? toMarkdownCode('yes') : toMarkdownCode('no')}`,
      '- Account: not logged in',
    ];
  }

  if (account.type === 'chatgpt') {
    return [
      `- Auth required: ${requiresOpenaiAuth ? toMarkdownCode('yes') : toMarkdownCode('no')}`,
      `- Account: ${toMarkdownCode(account.email)}`,
      `- Plan: ${toMarkdownCode(account.planType)}`,
    ];
  }

  return [
    `- Auth required: ${requiresOpenaiAuth ? toMarkdownCode('yes') : toMarkdownCode('no')}`,
    `- Account: ${toMarkdownCode('API key')}`,
  ];
}

function formatCodexThread(thread: CodexAppServerThread | null): string[] {
  if (!thread) return [];

  const lines: string[] = [
    `- Thread: ${toMarkdownCode(thread.id)}`,
  ];

  if (thread.status?.type) {
    const activeFlags = thread.status.type === 'active' && thread.status.activeFlags?.length
      ? ` (${thread.status.activeFlags.join(', ')})`
      : '';
    lines.push(`- Thread status: ${toMarkdownCode(`${thread.status.type}${activeFlags}`)}`);
  }
  if (thread.source) {
    lines.push(`- Thread source: ${toMarkdownCode(thread.source)}`);
  }
  if (thread.cwd) {
    lines.push(`- Thread cwd: ${toMarkdownCode(thread.cwd)}`);
  }
  if (thread.cliVersion) {
    lines.push(`- Thread CLI: ${toMarkdownCode(thread.cliVersion)}`);
  }

  return lines;
}

function formatCodexStatusMessage(options: {
  config: CodexAppServerConfig;
  thread: CodexAppServerThread | null;
  account: CodexAppServerAccount | null;
  requiresOpenaiAuth: boolean;
  mcpServers: CodexAppServerMcpServerStatus[];
  sessionModel?: string;
  sessionProviderId?: string;
  sessionReasoningEffort?: string;
  workingDirectory?: string;
}): string {
  const config = options.config;
  const effectiveModel = typeof config.model === 'string' && config.model
    ? config.model
    : (options.sessionModel || '(unknown)');
  const effectiveProvider = typeof config.model_provider === 'string' && config.model_provider
    ? config.model_provider
    : (options.sessionProviderId || 'env');
  const effectiveEffort = typeof config.model_reasoning_effort === 'string' && config.model_reasoning_effort
    ? config.model_reasoning_effort
    : (options.sessionReasoningEffort || '');

  return [
    '## Codex Runtime Status',
    `- Model: ${toMarkdownCode(effectiveModel)}`,
    `- Provider: ${toMarkdownCode(effectiveProvider)}`,
    effectiveEffort ? `- Reasoning effort: ${toMarkdownCode(effectiveEffort)}` : null,
    `- Approval policy: ${toMarkdownCode(typeof config.approval_policy === 'string' ? config.approval_policy : 'suggest')}`,
    typeof config.sandbox_mode === 'string' && config.sandbox_mode
      ? `- Sandbox: ${toMarkdownCode(config.sandbox_mode)}`
      : null,
    typeof config.web_search === 'string' && config.web_search
      ? `- Web search: ${toMarkdownCode(config.web_search)}`
      : null,
    typeof config.profile === 'string' && config.profile
      ? `- Profile: ${toMarkdownCode(config.profile)}`
      : null,
    options.workingDirectory ? `- Project: ${toMarkdownCode(options.workingDirectory)}` : null,
    ...formatCodexAccount(options.account, options.requiresOpenaiAuth),
    ...formatCodexThread(options.thread),
    `- MCP servers: ${options.mcpServers.length}`,
  ].filter(Boolean).join('\n');
}

function parseModelArgs(
  args: string,
  models: CodexModelOption[],
  currentEffort?: string,
): { error?: string; statePatch?: NativeCommandStatePatch; modelLabel?: string } {
  const [requestedModelRaw, requestedEffortRaw] = args.trim().split(/\s+/).filter(Boolean);
  if (!requestedModelRaw) {
    return { error: 'MODEL_REQUIRED' };
  }

  const selectedModel = models.find((model) => model.value === requestedModelRaw);
  if (!selectedModel) {
    return {
      error: `Unknown Codex model: ${requestedModelRaw}`,
    };
  }

  const explicitEffort = normalizeReasoningEffort(requestedEffortRaw);
  if (requestedEffortRaw && !explicitEffort) {
    return {
      error: `Unsupported reasoning effort: ${requestedEffortRaw}`,
    };
  }

  if (
    explicitEffort
    && selectedModel.reasoning_efforts?.length
    && !selectedModel.reasoning_efforts.includes(explicitEffort)
  ) {
    return {
      error: `Model ${selectedModel.value} does not support reasoning effort "${explicitEffort}"`,
    };
  }

  const statePatch: NativeCommandStatePatch = { model: selectedModel.value };
  const normalizedCurrentEffort = normalizeReasoningEffort(currentEffort);
  const nextEffort = explicitEffort
    || (
      normalizedCurrentEffort
      && selectedModel.reasoning_efforts?.includes(normalizedCurrentEffort)
        ? normalizedCurrentEffort
        : selectedModel.default_reasoning_effort
    )
    || '';

  if (nextEffort) {
    statePatch.reasoning_effort = nextEffort;
  }

  return {
    statePatch,
    modelLabel: selectedModel.label,
  };
}

export function createCodexNativeCommandRunner(overrides: Partial<RunnerDeps> = {}) {
  const deps: RunnerDeps = {
    withCodexAppServer,
    getSession,
    createSession,
    cloneSessionConversation,
    getCodexModelsCached,
    ...overrides,
  };
  return async function runCodexNativeCommand(
    request: NativeCommandControllerRequest,
  ): Promise<NativeCommandControllerResponse> {
    const commandName = request.command_name.trim().toLowerCase();
    if (!NATIVE_COMMAND_NAMES.has(commandName)) {
      return {
        handled: false,
        message: `Unsupported native command: /${commandName}`,
        error: 'UNSUPPORTED_NATIVE_COMMAND',
      };
    }

    if (request.engine_type !== 'codex') {
      return {
        handled: false,
        message: `Native Codex controller is unavailable for engine "${request.engine_type}".`,
        error: 'UNSUPPORTED_ENGINE',
      };
    }

    const session = request.session_id ? deps.getSession(request.session_id) : undefined;
    const workingDirectory = request.context?.working_directory || session?.working_directory || undefined;
    const currentModel = request.context?.model || session?.model || undefined;
    const currentProviderId = request.context?.provider_id || session?.provider_id || 'env';
    const currentReasoningEffort = request.context?.reasoning_effort || session?.reasoning_effort || undefined;
    const engineSessionId = session?.engine_session_id || session?.sdk_session_id || undefined;

    if (commandName === 'fork') {
      if (request.args?.trim()) {
        return {
          handled: false,
          message: 'Codex `/fork` does not accept arguments.',
          error: 'INVALID_FORK_ARGS',
        };
      }
      if (!request.session_id || !session) {
        return {
          handled: false,
          message: 'Codex `/fork` requires an active conversation.',
          error: 'SESSION_REQUIRED',
        };
      }
      if (!engineSessionId) {
        return {
          handled: false,
          message: 'Codex `/fork` requires an active Codex thread.',
          error: 'ENGINE_SESSION_REQUIRED',
        };
      }
    }

    // Commands that don't need the Codex app-server
    if (commandName === 'diff') {
      try {
        const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD'], {
          cwd: workingDirectory || process.cwd(),
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

    try {
      return await deps.withCodexAppServer(async (client: CodexAppServerClient) => {
        switch (commandName) {
          case 'model': {
            const models = normalizeCodexModelListPayload(
              await client.listModels({ includeHidden: false, limit: 128 }),
            );

            if (!request.args) {
              return {
                handled: true,
                message: formatCodexModelList(models, currentModel, currentReasoningEffort),
                data: { models },
              };
            }

            const parsed = parseModelArgs(request.args, models, currentReasoningEffort);
            if (parsed.error || !parsed.statePatch) {
              return {
                handled: false,
                message: parsed.error || 'Failed to parse Codex model arguments.',
                error: 'INVALID_MODEL_ARGS',
              };
            }

            // Persist model to ~/.codex/config.toml so it survives across sessions
            // Sync to config file
            const { syncConfigToFile: syncCodex } = await import('@/lib/config-sync');
            syncCodex('codex', {
              model: parsed.statePatch.model || parsed.modelLabel || '',
              reasoningEffort: parsed.statePatch.reasoning_effort || undefined,
            });

            const effortSuffix = parsed.statePatch.reasoning_effort
              ? ` with reasoning effort ${toMarkdownCode(parsed.statePatch.reasoning_effort)}`
              : '';

            return {
              handled: true,
              message: `Codex model switched to ${toMarkdownCode(parsed.statePatch.model || parsed.modelLabel || '')}${effortSuffix}.`,
              state_patch: parsed.statePatch,
              data: { models },
            };
          }

          case 'mcp': {
            const mcpServers = await client.listMcpServerStatus({ limit: 128 });
            return {
              handled: true,
              message: formatCodexMcpStatus(mcpServers),
              data: { mcp_servers: mcpServers },
            };
          }

          case 'status': {
            const [config, accountResult, mcpServers] = await Promise.all([
              client.readConfig({ cwd: workingDirectory, includeLayers: false }),
              client.readAccount({ refreshToken: false }),
              client.listMcpServerStatus({ limit: 128 }),
            ]);

            let thread: CodexAppServerThread | null = null;
            if (engineSessionId) {
              try {
                thread = await client.readThread({ threadId: engineSessionId, includeTurns: false });
              } catch {
                thread = null;
              }
            }

            return {
              handled: true,
              message: formatCodexStatusMessage({
                config,
                thread,
                account: accountResult.account,
                requiresOpenaiAuth: accountResult.requiresOpenaiAuth,
                mcpServers,
                sessionModel: currentModel,
                sessionProviderId: currentProviderId,
                sessionReasoningEffort: currentReasoningEffort,
                workingDirectory,
              }),
              data: {
                config,
                account: accountResult.account,
                requires_openai_auth: accountResult.requiresOpenaiAuth,
                thread,
                mcp_servers: mcpServers,
              },
            };
          }

          case 'fork': {
            const forkedThread = await client.forkThread({ threadId: engineSessionId! });
            const forkedTitle = buildForkedSessionTitle(session!.title, forkedThread.name);
            const forkedModel = currentModel || session!.model || undefined;
            const forkedReasoningEffort = currentReasoningEffort || session!.reasoning_effort || undefined;
            const forkedWorkingDirectory = workingDirectory || session!.working_directory || '';
            const forkedProviderId = currentProviderId || session!.provider_id || 'env';
            const forkedThreadId = forkedThread.id || '';
            if (!forkedThreadId) {
              return {
                handled: false,
                message: 'Codex did not return a forked thread id.',
                error: 'MISSING_FORKED_THREAD_ID',
              };
            }

            const forkedSession = deps.createSession(
              forkedTitle,
              forkedModel,
              forkedReasoningEffort,
              session!.system_prompt || '',
              forkedWorkingDirectory,
              request.context?.mode || session!.mode || 'code',
              forkedProviderId,
              'codex',
              forkedThreadId,
            );
            const clonedMessageCount = deps.cloneSessionConversation(session!.id, forkedSession.id);

            return {
              handled: true,
              message: 'Forked the current Codex conversation into ' + toMarkdownCode(forkedTitle) + '.',
              data: {
                new_session_id: forkedSession.id,
                new_thread_id: forkedThreadId,
                title: forkedTitle,
                model: forkedModel,
                provider_id: forkedProviderId,
                reasoning_effort: forkedReasoningEffort,
                working_directory: forkedWorkingDirectory,
                cloned_message_count: typeof clonedMessageCount === 'number' ? clonedMessageCount : null,
              },
            };
          }

          case 'permissions': {
            // Codex CLI shows friendly aliases but the config API uses internal values.
            // CLI alias → API value mapping:
            //   suggest     → on-request
            //   auto-edit   → on-failure
            //   full-auto   → never
            const POLICY_TO_API: Record<string, string> = {
              'suggest': 'on-request',
              'auto-edit': 'on-failure',
              'full-auto': 'never',
              // Also accept raw API values
              'on-request': 'on-request',
              'on-failure': 'on-failure',
              'never': 'never',
              'untrusted': 'untrusted',
              'reject': 'reject',
            };
            const API_TO_LABEL: Record<string, string> = {
              'on-request': 'suggest',
              'on-failure': 'auto-edit',
              'never': 'full-auto',
              'untrusted': 'untrusted',
              'reject': 'reject',
            };
            const config = await client.readConfig({ cwd: workingDirectory, includeLayers: false });
            const rawPolicy = typeof config.approval_policy === 'string' ? config.approval_policy : 'on-request';
            const policyLabel = API_TO_LABEL[rawPolicy] || rawPolicy;
            if (!request.args) {
              return {
                handled: true,
                message: `Current approval policy: ${toMarkdownCode(policyLabel)}`,
                data: {
                  approval_policy: policyLabel,
                  supported_policies: ['suggest', 'auto-edit', 'full-auto'],
                },
              };
            }
            const requested = request.args.trim().toLowerCase();
            const apiValue = POLICY_TO_API[requested];
            if (!apiValue) {
              return {
                handled: true,
                message: `Unknown approval policy: ${toMarkdownCode(requested)}. Valid options: ${['suggest', 'auto-edit', 'full-auto'].map(toMarkdownCode).join(', ')}.`,
                error: 'INVALID_POLICY',
              };
            }
            await client.writeConfigValue({ key: 'approval_policy', value: apiValue });
            // Sync approval policy + sandbox mode to config file
            const { syncConfigToFile: syncCodexPerm } = await import('@/lib/config-sync');
            syncCodexPerm('codex', { approvalPolicy: apiValue });
            const newLabel = API_TO_LABEL[apiValue] || apiValue;
            return {
              handled: true,
              message: `Codex approval policy changed to ${toMarkdownCode(newLabel)}.`,
              state_patch: { approval_policy: newLabel },
              data: { approval_policy: newLabel },
            };
          }

          case 'agent': {
            let thread: CodexAppServerThread | null = null;
            if (engineSessionId) {
              try {
                thread = await client.readThread({ threadId: engineSessionId, includeTurns: false });
              } catch { thread = null; }
            }
            const threads = await client.listThreads({ limit: 20 });
            const threadLines = threads.map(t => {
              const statusLabel = t.status?.type || 'unknown';
              const preview = t.preview ? ` — ${t.preview.slice(0, 60)}` : '';
              return `- ${toMarkdownCode(t.id)}: ${statusLabel}${preview}`;
            });
            const currentSection = thread
              ? `### Current Thread\n\n- ID: ${toMarkdownCode(thread.id)}\n- Source: ${toMarkdownCode(thread.source || '(unknown)')}\n- CWD: ${toMarkdownCode(thread.cwd || '(unknown)')}`
              : '### Current Thread\n\nNo active thread.';
            const listSection = threadLines.length > 0
              ? `### Recent Threads (${threads.length})\n\n${threadLines.join('\n')}`
              : '';
            return {
              handled: true,
              message: ['## Codex Agent', '', currentSection, '', listSection].filter(Boolean).join('\n'),
              data: { current_thread: thread, threads },
            };
          }

          case 'experimental': {
            const features = await client.listExperimentalFeatures();
            if (features.length === 0) {
              return {
                handled: true,
                message: '## Codex Experimental Features\n\nNo experimental features reported by runtime.',
                data: { features: [] },
              };
            }
            // Only show features that are user-visible (have displayName or are beta/stable & non-removed)
            const visible = features.filter(f =>
              f.displayName || (f.stage && f.stage !== 'removed' && f.stage !== 'deprecated'),
            );
            const lines = visible.map(f => {
              const status = f.enabled ? '✓' : '✗';
              const stage = f.stage ? ` [${f.stage}]` : '';
              const label = f.displayName || f.name || '(unnamed)';
              const desc = f.description ? ` — ${f.description}` : '';
              const announce = f.announcement && !f.enabled ? `\n  > ${f.announcement}` : '';
              return `- ${status} ${toMarkdownCode(label)}${stage}${desc}${announce}`;
            });
            return {
              handled: true,
              message: ['## Codex Experimental Features', '', ...lines].join('\n'),
              data: { features },
            };
          }

          case 'personality': {
            // collaborationMode/list may require experimentalApi capability — fall back to config
            let modes: Awaited<ReturnType<typeof client.listCollaborationModes>> = [];
            try { modes = await client.listCollaborationModes(); } catch { /* capability not available */ }
            if (modes.length === 0) {
              const config = await client.readConfig({ cwd: workingDirectory, includeLayers: false });
              const personality = typeof config.personality === 'string' ? config.personality : '(default)';
              return {
                handled: true,
                message: `## Codex Personality\n\nCurrent: ${toMarkdownCode(personality)}`,
                data: { personality },
              };
            }
            const lines = modes.map(m => {
              const def = m.isDefault ? ' (current)' : '';
              return `- ${toMarkdownCode(m.name || m.id || '(unnamed)')}${def}${m.description ? ` — ${m.description}` : ''}`;
            });
            return {
              handled: true,
              message: ['## Codex Collaboration Modes', '', ...lines].join('\n'),
              data: { modes },
            };
          }

          case 'ps': {
            let thread: CodexAppServerThread | null = null;
            if (engineSessionId) {
              try {
                thread = await client.readThread({ threadId: engineSessionId, includeTurns: false });
              } catch { thread = null; }
            }
            const status = thread?.status?.type || 'idle';
            const activeFlags = (thread?.status?.type === 'active' && thread?.status?.activeFlags?.length)
              ? ` (${thread.status.activeFlags.join(', ')})`
              : '';
            return {
              handled: true,
              message: thread
                ? `## Codex Process Status\n\n- Thread: ${toMarkdownCode(thread.id)}\n- Status: ${toMarkdownCode(`${status}${activeFlags}`)}`
                : '## Codex Process Status\n\nNo active thread.',
            };
          }

          case 'debug-config': {
            const config = await client.readConfig({ cwd: workingDirectory, includeLayers: true });
            return {
              handled: true,
              message: ['## Codex Config Diagnostics', '', '```json', JSON.stringify(config, null, 2), '```'].join('\n'),
              data: { config },
            };
          }

          case 'skills': {
            const cwds = workingDirectory ? [workingDirectory] : [];
            const skills = await client.listSkills({ cwds });
            if (skills.length === 0) {
              return {
                handled: true,
                message: '## Codex Skills\n\nNo skills reported by runtime.',
                data: { skills: [] },
              };
            }
            const lines = skills.map(s => {
              const status = s.isEnabled ? '✓' : '✗';
              const source = s.source ? ` [${s.source}]` : '';
              return `- ${status} ${toMarkdownCode(s.name || '(unnamed)')}${source}${s.description ? ` — ${s.description}` : ''}`;
            });
            return {
              handled: true,
              message: ['## Codex Skills', '', ...lines].join('\n'),
              data: { skills },
            };
          }

          case 'apps': {
            const apps = await client.listApps({ limit: 128 });
            if (apps.length === 0) {
              return {
                handled: true,
                message: '## Codex Apps\n\nNo apps reported by runtime.',
                data: { apps: [] },
              };
            }
            const lines = apps.map(a => {
              const access = a.isAccessible ? '✓' : '✗';
              const enabled = a.isEnabled ? ' (enabled)' : '';
              return `- ${access} ${toMarkdownCode(a.name || a.id || '(unnamed)')}${enabled}${a.description ? ` — ${a.description}` : ''}`;
            });
            return {
              handled: true,
              message: ['## Codex Apps', '', ...lines].join('\n'),
              data: { apps },
            };
          }

          case 'undo': {
            // Codex undo: revert uncommitted changes via git
            const cwd = workingDirectory || process.cwd();
            try {
              // Check what would be undone
              const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
                cwd,
                timeout: 10000,
              });
              const changes = statusOut.trim();
              if (!changes) {
                return {
                  handled: true,
                  message: '## Undo\n\nNo uncommitted changes to revert.',
                };
              }

              // Show what will be reverted (don't auto-revert, too dangerous)
              const lines = changes.split('\n').map(l => `- ${toMarkdownCode(l.trim())}`);
              return {
                handled: true,
                message: [
                  '## Undo — Uncommitted Changes',
                  '',
                  `Found ${lines.length} changed file(s):`,
                  '',
                  ...lines,
                  '',
                  'To revert all changes, run `git checkout .` in your terminal.',
                  'To revert a specific file, run `git checkout -- <file>`.',
                ].join('\n'),
              };
            } catch {
              return {
                handled: true,
                message: '## Undo\n\nFailed to check git status. Is this a git repository?',
              };
            }
          }

          default:
            return {
              handled: false,
              message: `Unsupported native command: /${commandName}` ,
              error: 'UNSUPPORTED_NATIVE_COMMAND',
            };
        }
      });
    } catch (error) {
      // Fallback: for /model no-args, use cached model discovery (real discovery + fallback)
      if (commandName === 'model' && !request.args) {
        const cachedModels = await deps.getCodexModelsCached();
        return {
          handled: true,
          message: formatCodexModelList(cachedModels, currentModel, currentReasoningEffort),
          data: { models: cachedModels },
        };
      }
      return {
        handled: false,
        message: error instanceof Error ? error.message : String(error),
        error: 'NATIVE_COMMAND_FAILED',
      };
    }
  };
}

export const runCodexNativeCommand = createCodexNativeCommandRunner();
