import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import { runRemoteCommand, quoteShellArg } from '@/lib/remote-ssh';
import { createSession, addMessage, updateSdkSessionId, getAllSessions } from '@/lib/db';
import type { MessageContentBlock } from '@/types';
import { parseCodexSessionContent } from '@/lib/codex-session-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REMOTE_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const REMOTE_FILE_MISSING_MARKER = '__CODEPILOT_REMOTE_FILE_MISSING__';

/**
 * POST /api/remote/cli-sessions/import
 * Import a CLI session from a remote host.
 *
 * Body: { connection_id, engine_type, session_id, dir_name }
 * Returns: { session: { id, title, messageCount, projectPath } }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      connection_id?: string;
      engine_type?: string;
      session_id?: string;
      dir_name?: string;
    };

    const connectionId = (body.connection_id || '').trim();
    const engineType = (body.engine_type || 'claude').trim();
    const sessionId = (body.session_id || '').trim();
    const dirName = (body.dir_name || '').trim();

    if (!connectionId) {
      return NextResponse.json({ error: 'connection_id is required' }, { status: 400 });
    }
    if (!sessionId) {
      return NextResponse.json({ error: 'session_id is required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    // Check for duplicate import
    const existingSessions = getAllSessions();
    const alreadyImported = existingSessions.find(
      s => s.sdk_session_id === sessionId || s.engine_session_id === sessionId,
    );
    if (alreadyImported) {
      return NextResponse.json(
        { error: 'This session has already been imported', existingSessionId: alreadyImported.id },
        { status: 409 },
      );
    }

    // Build the remote file path and read the file
    const fileLocation = buildRemoteFileLocation(engineType, sessionId, dirName);
    if (!fileLocation) {
      return NextResponse.json({ error: 'Cannot determine file path for the session' }, { status: 400 });
    }

    // Check file size first
    const sizeResult = await runRemoteCommand(
      connection,
      `${buildRemoteHomeFileSetup(fileLocation.relativePath)}
if [ ! -s "$FILE" ]; then
  printf '%s' ${quoteShellArg(REMOTE_FILE_MISSING_MARKER)}
  exit 0
fi
wc -c < "$FILE" 2>/dev/null | tr -d ' '`,
      { timeoutMs: 10000 },
    );
    const sizeOutput = sizeResult.stdout.trim();
    if (sizeOutput === REMOTE_FILE_MISSING_MARKER) {
      return NextResponse.json({ error: 'Session file not found or empty on remote host' }, { status: 404 });
    }
    const fileSize = parseInt(sizeOutput, 10);
    if (isNaN(fileSize) || fileSize === 0) {
      return NextResponse.json({ error: 'Session file not found or empty on remote host' }, { status: 404 });
    }
    if (fileSize > MAX_REMOTE_FILE_SIZE) {
      return NextResponse.json({ error: 'Session file too large (> 50 MB)' }, { status: 400 });
    }

    // Read the full file content
    const fileResult = await runRemoteCommand(
      connection,
      `${buildRemoteHomeFileSetup(fileLocation.relativePath)}
cat "$FILE"`,
      { timeoutMs: 60000 },
    );
    const fileContent = fileResult.stdout;

    // Parse and import based on engine type
    let result;
    if (engineType === 'codex') {
      result = importCodexSession(sessionId, fileContent, connectionId, connection.remote_root || '');
    } else if (engineType === 'gemini') {
      result = importGeminiSession(sessionId, fileContent, connectionId, connection.remote_root || '');
    } else {
      result = importClaudeSession(sessionId, dirName, fileContent, connectionId, connection.remote_root || '');
    }

    if (!result) {
      return NextResponse.json({ error: 'Session has no messages to import' }, { status: 400 });
    }

    return NextResponse.json({ session: result }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to import remote session';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface RemoteFileLocation {
  relativePath: string;
}

function buildRemoteFileLocation(engineType: string, sessionId: string, dirName: string): RemoteFileLocation | null {
  if (engineType === 'claude') {
    if (!dirName) return null;
    const relativePath = `.claude/projects/${dirName}/${sessionId}.jsonl`;
    return { relativePath };
  }
  if (engineType === 'codex') {
    // dirName is the relative path from ~/.codex/, e.g. sessions/YYYY/MM/DD/file.jsonl
    // or archived_sessions/<file>.jsonl
    if (!dirName) return null;
    const relativePath = `.codex/${dirName}`;
    return { relativePath };
  }
  if (engineType === 'gemini') {
    if (!dirName) return null;
    const relativePath = `.gemini/tmp/${dirName}/chats/${sessionId}.json`;
    return { relativePath };
  }
  return null;
}

function buildRemoteHomeFileSetup(relativePath: string): string {
  return `REL_PATH=${quoteShellArg(relativePath)}
FILE="$HOME/$REL_PATH"`;
}

// ── Claude import ────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
  contentBlocks: MessageContentBlock[];
  hasToolBlocks: boolean;
}

function importClaudeSession(
  sessionId: string,
  _dirName: string,
  fileContent: string,
  connectionId: string,
  remoteRoot: string,
) {
  const lines = fileContent.split('\n').filter(l => l.trim());
  const messages: ParsedMessage[] = [];
  let cwd = '';
  let gitBranch = '';
  let model = '';
  let preview = '';

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === 'user') {
        const userEntry = entry as {
          cwd?: string; gitBranch?: string; version?: string;
          message?: { content?: string | ContentBlock[] };
        };
        if (!cwd && userEntry.cwd) cwd = userEntry.cwd;
        if (!gitBranch && userEntry.gitBranch) gitBranch = userEntry.gitBranch;

        const msgContent = userEntry.message?.content;
        if (!msgContent) continue;
        let text: string;
        if (typeof msgContent === 'string') {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          text = msgContent.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
        } else continue;
        if (!text.trim()) continue;
        if (!preview) preview = text.slice(0, 50);
        messages.push({ role: 'user', content: text, contentBlocks: [{ type: 'text', text }], hasToolBlocks: false });

      } else if (entry.type === 'assistant') {
        const assistantEntry = entry as {
          message?: { content?: ContentBlock[]; model?: string };
        };
        if (!model && assistantEntry.message?.model) model = assistantEntry.message.model;
        const blocks = assistantEntry.message?.content;
        if (!Array.isArray(blocks)) continue;

        const contentBlocks: MessageContentBlock[] = [];
        const textParts: string[] = [];
        let hasToolBlocks = false;

        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            contentBlocks.push({ type: 'text', text: block.text });
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            hasToolBlocks = true;
            contentBlocks.push({ type: 'tool_use', id: block.id || '', name: block.name || '', input: block.input });
          } else if (block.type === 'tool_result') {
            hasToolBlocks = true;
            const resultContent = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n')
                : '';
            contentBlocks.push({ type: 'tool_result', tool_use_id: block.tool_use_id || '', content: resultContent, is_error: block.is_error || false });
          }
        }
        if (contentBlocks.length === 0) continue;
        messages.push({ role: 'assistant', content: textParts.join('\n'), contentBlocks, hasToolBlocks });
      }
    } catch { /* skip */ }
  }

  if (messages.length === 0) return null;

  const title = preview ? preview + (preview.length >= 50 ? '...' : '') : `Imported: remote session`;
  const remotePath = cwd || remoteRoot || '~';
  const session = createSession(
    title, model || undefined, undefined, undefined,
    remotePath, 'code', undefined, 'claude', undefined,
    'ssh_direct', connectionId, remotePath,
  );
  updateSdkSessionId(session.id, sessionId);

  for (const msg of messages) {
    const content = msg.hasToolBlocks ? JSON.stringify(msg.contentBlocks) : msg.content;
    if (content.trim()) addMessage(session.id, msg.role, content);
  }

  return { id: session.id, title, messageCount: messages.length, projectPath: remotePath, sdkSessionId: sessionId };
}

// ── Codex import ─────────────────────────────────────────────────────

function importCodexSession(
  sessionId: string,
  fileContent: string,
  connectionId: string,
  remoteRoot: string,
) {
  const parsed = parseCodexSessionContent(fileContent, {
    includeMessages: true,
    sessionIdFallback: sessionId,
  });
  if (!parsed) return null;

  const title = parsed.info.preview
    ? parsed.info.preview + (parsed.info.preview.length >= 50 ? '...' : '')
    : `Imported: remote codex session`;
  const remotePath = parsed.info.cwd || remoteRoot || '~';
  const session = createSession(
    title, parsed.info.model || undefined, parsed.info.reasoningEffort || undefined, undefined,
    remotePath, 'code', undefined, 'codex', parsed.info.sessionId || sessionId,
    'ssh_direct', connectionId, remotePath,
  );

  for (const msg of parsed.messages) {
    if (msg.content.trim()) addMessage(session.id, msg.role, msg.content);
  }

  return {
    id: session.id,
    title,
    messageCount: parsed.messages.length,
    projectPath: remotePath,
    engineSessionId: parsed.info.sessionId || sessionId,
  };
}

// ── Gemini import ────────────────────────────────────────────────────

function importGeminiSession(
  sessionId: string,
  fileContent: string,
  connectionId: string,
  remoteRoot: string,
) {
  const messages: ParsedMessage[] = [];
  let cwd = '';
  let model = '';
  let preview = '';

  try {
    const data = JSON.parse(fileContent) as Record<string, unknown>;
    if (data.cwd) cwd = String(data.cwd);

    const msgs = data.messages as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(msgs)) {
      for (const msg of msgs) {
        const parts = msg.content as Array<{ text?: string }> | undefined;
        const text = Array.isArray(parts) ? parts.map(p => p.text || '').join('\n') : '';
        if (!text.trim()) continue;

        if (msg.type === 'user') {
          if (!preview) preview = text.slice(0, 50);
          messages.push({ role: 'user', content: text, contentBlocks: [{ type: 'text', text }], hasToolBlocks: false });
        } else if (msg.type === 'gemini') {
          if (!model && msg.model) model = String(msg.model);
          messages.push({ role: 'assistant', content: text, contentBlocks: [{ type: 'text', text }], hasToolBlocks: false });
        }
      }
    }
  } catch { /* not valid JSON */ }

  if (messages.length === 0) return null;

  const title = preview ? preview + (preview.length >= 50 ? '...' : '') : `Imported: remote gemini session`;
  const remotePath = cwd || remoteRoot || '~';
  const session = createSession(
    title, model || undefined, undefined, undefined,
    remotePath, 'code', undefined, 'gemini', sessionId,
    'ssh_direct', connectionId, remotePath,
  );

  for (const msg of messages) {
    if (msg.content.trim()) addMessage(session.id, msg.role, msg.content);
  }

  return { id: session.id, title, messageCount: messages.length, projectPath: remotePath, engineSessionId: sessionId };
}
