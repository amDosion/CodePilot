import { getSession, getProvider, getDefaultProviderId } from '@/lib/db';
import { streamClaudePersistent } from '@/lib/claude-persistent-client';
import type { NativeCommandControllerRequest, SSEEvent, ApiProvider } from '@/types';

/**
 * Claude streaming native commands.
 *
 * Unlike Codex (which uses a separate app-server API for compact/review),
 * the Claude SDK natively intercepts prompts that start with "/" and executes
 * them as built-in slash commands. So we delegate to the existing
 * `streamClaudePersistent()` with the literal slash command as the prompt.
 */

const STREAM_NATIVE_COMMAND_NAMES = new Set(['compact', 'review']);

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function buildErrorStream(message: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(formatSSE({ type: 'error', data: message }));
      controller.enqueue(formatSSE({ type: 'done', data: '' }));
      controller.close();
    },
  });
}

function resolveProvider(providerId?: string): ApiProvider | undefined {
  if (!providerId || providerId === 'env') return undefined;
  const provider = getProvider(providerId);
  if (provider) return provider;
  const defaultId = getDefaultProviderId();
  if (defaultId) return getProvider(defaultId);
  return undefined;
}

export function isClaudeStreamNativeCommand(commandName: string): boolean {
  return STREAM_NATIVE_COMMAND_NAMES.has(commandName.trim().toLowerCase());
}

export function streamClaudeNativeCommand(
  request: NativeCommandControllerRequest,
): ReadableStream<string> {
  const commandName = request.command_name.trim().toLowerCase();

  if (!isClaudeStreamNativeCommand(commandName)) {
    return buildErrorStream(`Unsupported Claude streaming command: /${commandName}`);
  }

  if (request.engine_type !== 'claude') {
    return buildErrorStream(
      `Claude streaming command /${commandName} is unavailable for engine "${request.engine_type}".`,
    );
  }

  if (!request.session_id) {
    return buildErrorStream(`Claude command /${commandName} requires an active conversation.`);
  }

  const session = getSession(request.session_id);
  if (!session) {
    return buildErrorStream('Session not found.');
  }

  const engineSessionId = session.engine_session_id || session.sdk_session_id || '';
  if (!engineSessionId && commandName === 'compact') {
    return buildErrorStream(
      'Claude `/compact` requires an active session with conversation history. Send a message first.',
    );
  }

  // Build the literal slash command: "/compact [args]" or "/review [args]"
  const slashPrompt = request.args
    ? `/${commandName} ${request.args}`
    : `/${commandName}`;

  const providerId = request.context?.provider_id || session.provider_id || '';
  const provider = resolveProvider(providerId);

  // Delegate to the existing Claude persistent streaming.
  // The SDK intercepts prompts starting with "/" and executes them as native commands.
  return streamClaudePersistent({
    prompt: slashPrompt,
    sessionId: request.session_id,
    sdkSessionId: engineSessionId || undefined,
    model: request.context?.model || session.model || undefined,
    systemPrompt: session.system_prompt || undefined,
    workingDirectory: session.sdk_cwd || session.working_directory || undefined,
    workspaceTransport: session.workspace_transport as 'local' | 'ssh_direct' | undefined,
    remoteConnectionId: session.remote_connection_id || undefined,
    remotePath: session.remote_path || undefined,
    permissionMode: request.context?.mode || session.mode || 'code',
    provider,
  });
}
