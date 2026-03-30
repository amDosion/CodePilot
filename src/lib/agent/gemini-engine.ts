import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import posixPath from 'path/posix';
import { getRemoteConnection } from '@/lib/remote-connections';
import { buildGeminiSpawnCommand } from '@/lib/gemini-cli';
import {
  buildSshProcessArgs,
  quoteShellArg,
  resolveInteractiveTerminalType,
  resolveRemoteAbsolutePath,
  shellJoin,
  syncRemoteFile,
} from '@/lib/remote-ssh';
import type { SSEEvent, TokenUsage, FileAttachment, RemoteConnection } from '@/types';
import type { AgentEngine, EngineCapability, EngineStreamOptions } from './types';

const GEMINI_CAPABILITIES: readonly EngineCapability[] = [
  'streaming',
  'permission_mode',
  'mcp',
];

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function mapApprovalMode(permissionMode?: string): string {
  switch ((permissionMode || '').trim()) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'auto_edit';
    case 'bypassPermissions':
      return 'yolo';
    case 'default':
    default:
      return 'default';
  }
}

function resolveAttachmentPath(file: FileAttachment): string | null {
  if (!file.filePath) return null;
  return fs.existsSync(file.filePath) ? file.filePath : null;
}

function isPathInside(baseDir: string, targetPath: string): boolean {
  const relativePath = path.relative(baseDir, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function resolveAttachmentReferences(
  options: EngineStreamOptions,
  remoteConnection?: RemoteConnection,
): Promise<string[]> {
  const files = options.files || [];
  if (files.length === 0) return [];

  const references: string[] = [];
  const workingDirectory = options.workingDirectory ? path.resolve(options.workingDirectory) : '';
  const remoteWorkspaceRoot = remoteConnection && options.remotePath
    ? resolveRemoteAbsolutePath(remoteConnection, options.remotePath)
    : '';

  for (const file of files) {
    const attachmentPath = resolveAttachmentPath(file);
    if (!attachmentPath) {
      references.push(file.name);
      continue;
    }

    const resolvedLocalPath = path.resolve(attachmentPath);

    if (remoteConnection && workingDirectory && remoteWorkspaceRoot && isPathInside(workingDirectory, resolvedLocalPath)) {
      const relativePath = path.relative(workingDirectory, resolvedLocalPath).split(path.sep).join('/');
      const remoteAttachmentPath = posixPath.join(remoteWorkspaceRoot, relativePath);
      await syncRemoteFile(remoteConnection, resolvedLocalPath, remoteAttachmentPath);
      references.push(remoteAttachmentPath);
      continue;
    }

    references.push(resolvedLocalPath);
  }

  return references;
}

function buildGeminiPrompt(options: EngineStreamOptions, attachmentReferences: string[]): string {
  const lines: string[] = [];

  if (options.systemPrompt?.trim()) {
    lines.push('<system_instructions>');
    lines.push(options.systemPrompt.trim());
    lines.push('</system_instructions>');
    lines.push('');
  }

  if (options.conversationHistory && options.conversationHistory.length > 0) {
    lines.push('<conversation_history>');
    for (const entry of options.conversationHistory) {
      lines.push(`${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`);
    }
    lines.push('</conversation_history>');
    lines.push('');
  }

  if (attachmentReferences.length > 0) {
    lines.push('<attachments>');
    for (const reference of attachmentReferences) {
      lines.push(`Attached file: ${reference}`);
    }
    lines.push('</attachments>');
    lines.push('');
  }

  lines.push(options.prompt);
  return lines.join('\n');
}

function buildGeminiArgs(options: EngineStreamOptions): string[] {
  const args = [
    '--prompt',
    '',
    '--output-format',
    'text',
    '--approval-mode',
    mapApprovalMode(options.permissionMode),
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  return args;
}

function spawnLocalGemini(options: EngineStreamOptions, promptText: string): ChildProcess {
  const command = buildGeminiSpawnCommand(buildGeminiArgs(options));
  const env = { ...command.env };
  if (options.provider?.api_key && !env.GEMINI_API_KEY) {
    env.GEMINI_API_KEY = options.provider.api_key;
  }

  const child = spawn(command.command, command.args, {
    cwd: options.workingDirectory,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(promptText);
  return child;
}

function spawnRemoteGemini(
  connection: RemoteConnection,
  options: EngineStreamOptions,
  promptText: string,
): ChildProcess {
  const remoteWorkingDirectory = resolveRemoteAbsolutePath(connection, options.remotePath || connection.remote_root || '');
  const envExports = [
    `export TERM=${quoteShellArg(resolveInteractiveTerminalType())}`,
  ];

  if (options.provider?.api_key) {
    envExports.push(`export GEMINI_API_KEY=${quoteShellArg(options.provider.api_key)}`);
  }

  const geminiInvocation = shellJoin(['gemini', ...buildGeminiArgs(options)]);
  const remoteCommand = [
    `cd ${quoteShellArg(remoteWorkingDirectory)}`,
    ...envExports,
    `exec ${geminiInvocation}`,
  ].join(' && ');

  const child = spawn(
    'ssh',
    buildSshProcessArgs(connection, [`sh -lc ${quoteShellArg(remoteCommand)}`], { batchMode: true }),
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin.end(promptText);
  return child;
}

function emitTerminalLifecycle(
  child: ChildProcess,
  options: EngineStreamOptions,
  emit: (event: SSEEvent) => void,
  close: () => void,
): void {
  let stdoutSeen = false;
  let stderrBuffer = '';
  let closed = false;

  const safeClose = () => {
    if (closed) return;
    closed = true;
    close();
  };

  const abortHandler = () => {
    child.kill('SIGTERM');
  };
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    options.onRuntimeStatusChange?.('error');
    emit({ type: 'error', data: 'Gemini CLI process streams are unavailable.' });
    emit({ type: 'done', data: '' });
    safeClose();
    return;
  }

  options.abortController?.signal.addEventListener('abort', abortHandler);

  stdout.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (!text) return;
    stdoutSeen = true;
    emit({ type: 'text', data: text });
  });

  stderr.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (!text) return;
    stderrBuffer += text;
  });

  child.on('error', (error) => {
    options.abortController?.signal.removeEventListener('abort', abortHandler);
    options.onRuntimeStatusChange?.('error');
    emit({ type: 'error', data: error.message || 'Failed to start Gemini CLI.' });
    emit({ type: 'done', data: '' });
    safeClose();
  });

  child.on('close', (code) => {
    options.abortController?.signal.removeEventListener('abort', abortHandler);
    if (code === 0) {
      options.onRuntimeStatusChange?.('idle');
      const usage: TokenUsage = {
        input_tokens: 0,
        output_tokens: 0,
      };
      emit({
        type: 'result',
        data: JSON.stringify({
          usage,
          is_error: false,
        }),
      });
    } else {
      options.onRuntimeStatusChange?.('error');
      emit({
        type: 'error',
        data: stderrBuffer.trim() || (!stdoutSeen ? 'Gemini CLI exited without output.' : `Gemini CLI exited with code ${code ?? 'unknown'}.`),
      });
    }
    emit({ type: 'done', data: '' });
    safeClose();
  });
}

export class GeminiEngine implements AgentEngine {
  readonly type = 'gemini' as const;
  readonly capabilities = GEMINI_CAPABILITIES;

  stream(options: EngineStreamOptions): ReadableStream<string> {
    const isRemote = options.workspaceTransport === 'ssh_direct' && options.remoteConnectionId;
    const remoteConnection = isRemote
      ? getRemoteConnection(options.remoteConnectionId!)
      : undefined;

    return new ReadableStream<string>({
      async start(controller) {
        const emit = (event: SSEEvent) => {
          controller.enqueue(formatSSE(event));
        };

        try {
          if (isRemote && !remoteConnection) {
            options.onRuntimeStatusChange?.('error');
            emit({ type: 'error', data: 'Remote connection not found for Gemini runtime.' });
            emit({ type: 'done', data: '' });
            controller.close();
            return;
          }

          const attachmentReferences = await resolveAttachmentReferences(options, remoteConnection);
          const promptText = buildGeminiPrompt(options, attachmentReferences);
          options.onRuntimeStatusChange?.('running');
          emit({
            type: 'status',
            data: JSON.stringify({
              model: options.model || 'auto-gemini-2.5',
              runtime: remoteConnection ? 'remote' : 'local',
            }),
          });

          const child = remoteConnection
            ? spawnRemoteGemini(remoteConnection, options, promptText)
            : spawnLocalGemini(options, promptText);

          emitTerminalLifecycle(child, options, emit, () => controller.close());
        } catch (error) {
          options.onRuntimeStatusChange?.('error');
          emit({ type: 'error', data: error instanceof Error ? error.message : 'Failed to start Gemini CLI.' });
          emit({ type: 'done', data: '' });
          controller.close();
        }
      },
    });
  }
}
