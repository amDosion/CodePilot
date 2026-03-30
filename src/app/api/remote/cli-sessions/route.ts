import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import { runRemoteCommand } from '@/lib/remote-ssh';
import posixPath from 'path/posix';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RemoteCliSessionInfo {
  sessionId: string;
  projectPath: string;
  projectName: string;
  cwd: string;
  gitBranch: string;
  version: string;
  preview: string;
  userMessageCount: number;
  assistantMessageCount: number;
  createdAt: string;
  updatedAt: string;
  fileSize: number;
  model: string;
  engineType: 'claude' | 'codex' | 'gemini';
  /** Directory name inside ~/.claude/projects/ (needed for import) */
  dirName: string;
}

/**
 * POST /api/remote/cli-sessions
 * Discover CLI sessions on a remote host.
 *
 * Body: { connection_id, engine_type? }
 * Returns: { sessions: RemoteCliSessionInfo[] }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      connection_id?: string;
      engine_type?: string;
    };

    const connectionId = (body.connection_id || '').trim();
    if (!connectionId) {
      return NextResponse.json({ error: 'connection_id is required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    const engineType = (body.engine_type || 'claude').trim();

    let sessions: RemoteCliSessionInfo[];
    if (engineType === 'codex') {
      sessions = await discoverCodexSessions(connectionId, connection);
    } else if (engineType === 'gemini') {
      sessions = await discoverGeminiSessions(connectionId, connection);
    } else {
      sessions = await discoverClaudeSessions(connectionId, connection);
    }

    return NextResponse.json({ sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to discover remote sessions';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── Claude Code sessions: ~/.claude/projects/<dir>/<uuid>.jsonl ──────

async function discoverClaudeSessions(
  _connectionId: string,
  connection: Parameters<typeof runRemoteCommand>[0],
): Promise<RemoteCliSessionInfo[]> {
  // Single SSH command: find all .jsonl files, output metadata + first 30 lines per file
  // Using markers to delimit sections so we can parse the output reliably
  const script = `
PROJECTS_DIR="$HOME/.claude/projects"
[ -d "$PROJECTS_DIR" ] || exit 0
find "$PROJECTS_DIR" -name '*.jsonl' -type f 2>/dev/null | head -100 | while IFS= read -r f; do
  dir_name=$(basename "$(dirname "$f")")
  sid=$(basename "$f" .jsonl)
  fsize=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
  echo "===CS=== $dir_name $sid $fsize"
  head -80 "$f" 2>/dev/null
  echo "===CE==="
done
`.trim();

  const result = await runRemoteCommand(connection, script, { timeoutMs: 30000 });
  return parseClaudeDiscoveryOutput(result.stdout);
}

function parseClaudeDiscoveryOutput(output: string): RemoteCliSessionInfo[] {
  const sessions: RemoteCliSessionInfo[] = [];
  const sections = output.split('===CS=== ');

  for (const section of sections) {
    if (!section.trim()) continue;
    const endIdx = section.indexOf('\n');
    if (endIdx < 0) continue;

    const header = section.slice(0, endIdx).trim();
    const parts = header.split(' ');
    if (parts.length < 3) continue;

    const dirName = parts[0];
    const sessionId = parts[1];
    const fileSize = parseInt(parts[2], 10) || 0;

    // Extract JSONL content between header and ===CE===
    const ceIdx = section.indexOf('===CE===');
    const jsonlContent = ceIdx > 0 ? section.slice(endIdx + 1, ceIdx) : section.slice(endIdx + 1);
    const lines = jsonlContent.split('\n').filter(l => l.trim());

    // Parse session metadata from JSONL lines
    let cwd = '';
    let gitBranch = '';
    let version = '';
    let preview = '';
    let createdAt = '';
    let updatedAt = '';
    let userCount = 0;
    let assistantCount = 0;
    let model = '';

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.timestamp) {
          if (!createdAt) createdAt = String(entry.timestamp);
          updatedAt = String(entry.timestamp);
        }
        if (entry.type === 'user') {
          userCount++;
          if (!cwd && entry.cwd) cwd = String(entry.cwd);
          if (!gitBranch && entry.gitBranch) gitBranch = String(entry.gitBranch);
          if (!version && entry.version) version = String(entry.version);
          if (!preview) {
            const msg = entry.message as { content?: unknown } | undefined;
            if (msg?.content) {
              if (typeof msg.content === 'string') {
                preview = msg.content.slice(0, 120);
              } else if (Array.isArray(msg.content)) {
                const textBlock = msg.content.find((b: Record<string, unknown>) => b.type === 'text');
                if (textBlock?.text) preview = String(textBlock.text).slice(0, 120);
              }
            }
          }
        } else if (entry.type === 'assistant') {
          assistantCount++;
          const msg = entry.message as { model?: string } | undefined;
          if (!model && msg?.model) model = msg.model;
        }
      } catch { /* skip malformed lines */ }
    }

    if (userCount === 0 && assistantCount === 0) continue;

    // Decode project path from directory name
    const decodedPath = dirName.startsWith('-')
      ? dirName.replace(/^-/, '/').replace(/-/g, '/')
      : dirName;
    const effectivePath = cwd || decodedPath;

    sessions.push({
      sessionId,
      projectPath: effectivePath,
      projectName: posixPath.basename(effectivePath),
      cwd: effectivePath,
      gitBranch,
      version,
      preview: preview || '(no preview)',
      userMessageCount: userCount,
      assistantMessageCount: assistantCount,
      createdAt: createdAt || new Date().toISOString(),
      updatedAt: updatedAt || new Date().toISOString(),
      fileSize,
      model,
      engineType: 'claude',
      dirName,
    });
  }

  // Sort by most recent first
  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}

// ── Codex sessions: ~/.codex/sessions/YYYY/MM/DD/*.jsonl ─────────────

async function discoverCodexSessions(
  _connectionId: string,
  connection: Parameters<typeof runRemoteCommand>[0],
): Promise<RemoteCliSessionInfo[]> {
  const script = `
BASE="$HOME/.codex"
[ -d "$BASE" ] || exit 0
{
  [ -d "$BASE/sessions" ] && find "$BASE/sessions" -name '*.jsonl' -type f 2>/dev/null
  [ -d "$BASE/archived_sessions" ] && find "$BASE/archived_sessions" -name '*.jsonl' -type f 2>/dev/null
} | sort -r | head -100 | while IFS= read -r f; do
  relpath=$(echo "$f" | sed "s|^$BASE/||")
  fsize=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
  meta=$(grep -m1 '"type":"session_meta"' "$f" 2>/dev/null || true)
  ctx=$(grep -m1 '"type":"turn_context"' "$f" 2>/dev/null || true)
  first_user=$(grep -m1 '"type":"event_msg".*"type":"user_message"' "$f" 2>/dev/null || true)
  session_id=$(printf '%s\n' "$meta" | sed -n 's/.*"payload":{"id":"\\([^"]*\\)".*/\\1/p' | head -1)
  if [ -z "$session_id" ]; then
    session_id=$(basename "$f" .jsonl)
  fi
  cwd=$( { printf '%s\n' "$meta"; printf '%s\n' "$ctx"; } | sed -n 's/.*"cwd":"\\([^"]*\\)".*/\\1/p' | head -1)
  git_branch=$(printf '%s\n' "$meta" | sed -n 's/.*"branch":"\\([^"]*\\)".*/\\1/p' | head -1)
  version=$(printf '%s\n' "$meta" | sed -n 's/.*"cli_version":"\\([^"]*\\)".*/\\1/p' | head -1)
  model=$(printf '%s\n' "$ctx" | sed -n 's/.*"model":"\\([^"]*\\)".*/\\1/p' | head -1)
  created_at=$(printf '%s\n' "$meta" | sed -n 's/^{"timestamp":"\\([^"]*\\)".*/\\1/p' | head -1)
  updated_at=$(tail -n 200 "$f" 2>/dev/null | sed -n 's/^{"timestamp":"\\([^"]*\\)".*/\\1/p' | tail -1)
  user_count=$(grep -c '"type":"event_msg".*"type":"user_message"' "$f" 2>/dev/null || true)
  assistant_count=$(grep -c '"type":"event_msg".*"type":"agent_message".*"phase":"final_answer"' "$f" 2>/dev/null || true)
  preview=$(printf '%s\n' "$first_user" | sed -n 's/.*"message":"\\(.*\\)".*/\\1/p' | sed 's/\\"/"/g; s/\\\\n/ /g; s/\\\\t/ /g' | cut -c1-120)
  echo "===CS==="
  printf 'session_id=%s\n' "$session_id"
  printf 'relpath=%s\n' "$relpath"
  printf 'file_size=%s\n' "$fsize"
  printf 'cwd=%s\n' "$cwd"
  printf 'git_branch=%s\n' "$git_branch"
  printf 'version=%s\n' "$version"
  printf 'model=%s\n' "$model"
  printf 'created_at=%s\n' "$created_at"
  printf 'updated_at=%s\n' "$updated_at"
  printf 'user_count=%s\n' "$user_count"
  printf 'assistant_count=%s\n' "$assistant_count"
  printf 'preview=%s\n' "$preview"
  echo "===CE==="
done
`.trim();

  const result = await runRemoteCommand(connection, script, { timeoutMs: 30000 });
  return parseCodexDiscoveryOutput(result.stdout);
}

function parseCodexDiscoveryOutput(output: string): RemoteCliSessionInfo[] {
  const sessions: RemoteCliSessionInfo[] = [];
  const sections = output.split('===CS===');

  for (const section of sections) {
    if (!section.trim()) continue;
    const ceIdx = section.indexOf('===CE===');
    const body = ceIdx > -1 ? section.slice(0, ceIdx) : section;
    const data = new Map<string, string>();

    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 0) continue;
      const key = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 1);
      data.set(key, value);
    }

    const sessionId = (data.get('session_id') || '').trim();
    const relPath = (data.get('relpath') || '').trim();
    const fileSize = parseInt(data.get('file_size') || '0', 10) || 0;
    const userMessageCount = parseInt(data.get('user_count') || '0', 10) || 0;
    const assistantMessageCount = parseInt(data.get('assistant_count') || '0', 10) || 0;
    if (!sessionId || !relPath || (userMessageCount === 0 && assistantMessageCount === 0)) {
      continue;
    }

    const effectivePath = (data.get('cwd') || '').trim() || '~';
    sessions.push({
      sessionId,
      projectPath: effectivePath,
      projectName: posixPath.basename(effectivePath),
      cwd: effectivePath,
      gitBranch: (data.get('git_branch') || '').trim(),
      version: (data.get('version') || '').trim(),
      preview: (data.get('preview') || '').trim() || '(no preview)',
      userMessageCount,
      assistantMessageCount,
      createdAt: (data.get('created_at') || '').trim() || new Date().toISOString(),
      updatedAt: (data.get('updated_at') || '').trim() || new Date().toISOString(),
      fileSize,
      model: (data.get('model') || '').trim(),
      engineType: 'codex',
      dirName: relPath,
    });
  }

  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}

// ── Gemini sessions: ~/.gemini/tmp/<hash>/chats/*.json ───────────────

async function discoverGeminiSessions(
  _connectionId: string,
  connection: Parameters<typeof runRemoteCommand>[0],
): Promise<RemoteCliSessionInfo[]> {
  const script = `
BASE="$HOME/.gemini/tmp"
[ -d "$BASE" ] || exit 0
find "$BASE" -path '*/chats/*.json' -type f 2>/dev/null | head -100 | while IFS= read -r f; do
  project_dir=$(dirname "$(dirname "$f")")
  project_hash=$(basename "$project_dir")
  sid=$(basename "$f" .json)
  fsize=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
  echo "===CS=== $project_hash $sid $fsize"
  head -200 "$f" 2>/dev/null
  echo "===CE==="
done
`.trim();

  const result = await runRemoteCommand(connection, script, { timeoutMs: 30000 });
  return parseGeminiDiscoveryOutput(result.stdout);
}

function parseGeminiDiscoveryOutput(output: string): RemoteCliSessionInfo[] {
  const sessions: RemoteCliSessionInfo[] = [];
  const sections = output.split('===CS=== ');

  for (const section of sections) {
    if (!section.trim()) continue;
    const endIdx = section.indexOf('\n');
    if (endIdx < 0) continue;

    const header = section.slice(0, endIdx).trim();
    const parts = header.split(' ');
    if (parts.length < 3) continue;

    const projectHash = parts[0];
    const sessionId = parts[1];
    const fileSize = parseInt(parts[2], 10) || 0;

    const ceIdx = section.indexOf('===CE===');
    const jsonContent = ceIdx > 0 ? section.slice(endIdx + 1, ceIdx) : section.slice(endIdx + 1);

    let cwd = '';
    let preview = '';
    let createdAt = '';
    let updatedAt = '';
    let userCount = 0;
    let assistantCount = 0;
    let model = '';

    try {
      const data = JSON.parse(jsonContent) as Record<string, unknown>;
      if (data.startTime) createdAt = String(data.startTime);
      if (data.lastUpdated) updatedAt = String(data.lastUpdated);
      if (data.cwd) cwd = String(data.cwd);

      const messages = data.messages as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          if (msg.type === 'user') {
            userCount++;
            if (!preview) {
              const parts = msg.content as Array<{ text?: string }> | undefined;
              if (Array.isArray(parts)) {
                const text = parts.find(p => p.text)?.text;
                if (text) preview = text.slice(0, 120);
              }
            }
          } else if (msg.type === 'gemini') {
            assistantCount++;
            if (!model && msg.model) model = String(msg.model);
          }
        }
      }
    } catch { /* not valid JSON, skip */ }

    if (userCount === 0 && assistantCount === 0) continue;

    const effectivePath = cwd || `~/.gemini/tmp/${projectHash}`;
    sessions.push({
      sessionId,
      projectPath: effectivePath,
      projectName: posixPath.basename(effectivePath),
      cwd: effectivePath,
      gitBranch: '',
      version: '',
      preview: preview || '(no preview)',
      userMessageCount: userCount,
      assistantMessageCount: assistantCount,
      createdAt: createdAt || new Date().toISOString(),
      updatedAt: updatedAt || new Date().toISOString(),
      fileSize,
      model,
      engineType: 'gemini',
      dirName: projectHash,
    });
  }

  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}
