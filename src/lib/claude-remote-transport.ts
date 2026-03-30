import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { SDKUserMessage, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import os from 'os';
import type { ClaudeStreamOptions, RemoteConnection } from '@/types';
import { isImageFile } from '@/types';
import { buildSshProcessArgs, quoteShellArg, shellJoin } from '@/lib/remote-ssh';
import { prepareRemoteAttachments } from '@/lib/agent/attachment-paths';

function buildPromptWithHistory(
  prompt: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (!history || history.length === 0) return prompt;

  const lines: string[] = ['<conversation_history>'];
  for (const msg of history) {
    let content = msg.content;
    if (msg.role === 'assistant' && content.startsWith('[')) {
      try {
        const blocks = JSON.parse(content);
        const parts: string[] = [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) parts.push(block.text);
          else if (block.type === 'tool_use') parts.push(`[Used tool: ${block.name}]`);
          else if (block.type === 'tool_result') {
            const resultStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            parts.push(`[Tool result: ${resultStr.slice(0, 500)}${resultStr.length > 500 ? '...' : ''}]`);
          }
        }
        content = parts.join('\n');
      } catch {
        // ignore malformed structured history
      }
    }
    lines.push(`${msg.role === 'user' ? 'Human' : 'Assistant'}: ${content}`);
  }
  lines.push('</conversation_history>');
  lines.push('');
  lines.push(prompt);
  return lines.join('\n');
}

function filterRemoteEnv(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (key.startsWith('ANTHROPIC_')) {
      filtered[key] = value;
      continue;
    }
    if (key === 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC') {
      filtered[key] = value;
      continue;
    }
    if (key === 'CLAUDE_CODE_MAX_OUTPUT_TOKENS') {
      filtered[key] = value;
      continue;
    }
  }
  return filtered;
}

function buildRemoteShellScript(commandArgs: string[], cwd: string | undefined, env: Record<string, string>): string {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${quoteShellArg(value)};`)
    .join(' ');
  const command = shellJoin(commandArgs);
  if (cwd) {
    return `cd ${quoteShellArg(cwd)} && ${exports} ${command}`.trim();
  }
  return `${exports} ${command}`.trim();
}

export function createRemoteClaudeSpawner(
  connection: RemoteConnection,
  remoteEnv: Record<string, string>,
): (options: SpawnOptions) => ChildProcessWithoutNullStreams {
  return (options: SpawnOptions) => {
    const shellScript = buildRemoteShellScript(
      ['claude', ...options.args],
      options.cwd,
      filterRemoteEnv(remoteEnv),
    );
    return spawn('ssh', buildSshProcessArgs(connection, ['sh', '-lc', shellScript], { batchMode: false }), {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    });
  };
}

export async function buildRemoteClaudeUserMessage(
  options: ClaudeStreamOptions,
  useHistory: boolean,
  connection: RemoteConnection,
  remoteWorkspacePath: string,
): Promise<SDKUserMessage> {
  const basePrompt = useHistory
    ? buildPromptWithHistory(options.prompt, options.conversationHistory)
    : options.prompt;

  const files = options.files || [];
  if (files.length === 0) {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: basePrompt }],
      },
      parent_tool_use_id: null,
      session_id: '',
    };
  }

  const localWorkingDirectory = options.workingDirectory || os.homedir();
  const prepared = await prepareRemoteAttachments(files, localWorkingDirectory, connection, remoteWorkspacePath);
  const imageFiles = prepared.filter((entry) => isImageFile(entry.file.type));
  const nonImageFiles = prepared.filter((entry) => !isImageFile(entry.file.type));
  let textPrompt = basePrompt;

  if (nonImageFiles.length > 0) {
    const fileReferences = nonImageFiles
      .map((entry) => `[User attached file: ${entry.remotePath} (${entry.file.name})]`)
      .join('\n');
    textPrompt = `${fileReferences}\n\nPlease read the attached file(s) above using your Read tool, then respond to the user's message:\n\n${basePrompt}`;
  }

  if (imageFiles.length > 0) {
    const textWithImageRefs = options.imageAgentMode
      ? textPrompt
      : `${imageFiles
        .map((entry) => `[User attached image: ${entry.remotePath} (${entry.file.name})]`)
        .join('\n')}\n\n${textPrompt}`;

    const contentBlocks: Array<
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
      | { type: 'text'; text: string }
    > = imageFiles.map((entry) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: entry.file.type || 'image/png',
        data: entry.file.data,
      },
    }));

    contentBlocks.push({ type: 'text', text: textWithImageRefs });

    return {
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks,
      },
      parent_tool_use_id: null,
      session_id: '',
    };
  }

  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: textPrompt }],
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}
