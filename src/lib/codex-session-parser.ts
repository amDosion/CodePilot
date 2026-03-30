/**
 * Parser for Codex CLI session files (.jsonl).
 *
 * Codex stores sessions in:
 *   ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 * and archived sessions in:
 *   ~/.codex/archived_sessions/*.jsonl
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { MessageContentBlock } from '@/types';
import { normalizeReasoningEffort } from '@/lib/engine-defaults';

const MAX_FILE_SIZE = 50 * 1024 * 1024;

type EngineType = 'claude' | 'codex';

interface JsonlEntry {
  timestamp?: string;
  type: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

interface SessionMetaPayload {
  id?: string;
  timestamp?: string;
  cwd?: string;
  cli_version?: string;
  git?: {
    branch?: string;
  };
}

interface TurnContextPayload {
  model?: string;
  effort?: string;
  collaboration_mode?: {
    settings?: {
      model?: string;
      reasoning_effort?: string;
    };
  };
}

interface EventMessagePayload {
  type?: string;
  phase?: string;
  message?: string;
}

export interface CodexSessionInfo {
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
  reasoningEffort: string;
  engineType: EngineType;
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
  contentBlocks: MessageContentBlock[];
  hasToolBlocks: boolean;
  timestamp: string;
}

export interface ParsedSession {
  info: CodexSessionInfo;
  messages: ParsedMessage[];
}

interface ParseCodexContentOptions {
  includeMessages?: boolean;
  filePath?: string;
  fileSize?: number;
  createdAtFallback?: string;
  updatedAtFallback?: string;
  sessionIdFallback?: string;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toSessionMetaPayload(payload: unknown): SessionMetaPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const gitRaw = record.git;
  const git = gitRaw && typeof gitRaw === 'object' && !Array.isArray(gitRaw)
    ? { branch: safeString((gitRaw as Record<string, unknown>).branch) }
    : undefined;
  return {
    id: safeString(record.id),
    timestamp: safeString(record.timestamp),
    cwd: safeString(record.cwd),
    cli_version: safeString(record.cli_version),
    git,
  };
}

function toTurnContextPayload(payload: unknown): TurnContextPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const cmRaw = record.collaboration_mode;
  const settingsRaw = cmRaw && typeof cmRaw === 'object' && !Array.isArray(cmRaw)
    ? (cmRaw as Record<string, unknown>).settings
    : undefined;
  const settings = settingsRaw && typeof settingsRaw === 'object' && !Array.isArray(settingsRaw)
    ? {
        model: safeString((settingsRaw as Record<string, unknown>).model),
        reasoning_effort: safeString((settingsRaw as Record<string, unknown>).reasoning_effort),
      }
    : undefined;

  return {
    model: safeString(record.model),
    effort: safeString(record.effort),
    collaboration_mode: settings ? { settings } : undefined,
  };
}

function toEventMessagePayload(payload: unknown): EventMessagePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return {
    type: safeString(record.type),
    phase: safeString(record.phase),
    message: safeString(record.message),
  };
}

function isFinalAgentPhase(phase: string): boolean {
  const normalized = phase.trim().toLowerCase();
  return normalized === '' || normalized === 'final_answer';
}

function readJsonlLines(filePath: string): { lines: string[]; stat: fs.Stats } | null {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    console.warn(`[codex-session-parser] Skipping ${filePath}: file too large (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());
  return { lines, stat };
}

function fallbackFileStem(filePath?: string): string {
  if (!filePath) return '';
  return path.basename(filePath, path.extname(filePath));
}

function getEntryPayload(entry: JsonlEntry): unknown {
  return entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
    ? entry.payload
    : entry;
}

function listJsonlFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const results: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(absPath);
      }
    }
  }

  return results;
}

export function getCodexSessionsDir(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

export function getCodexArchivedSessionsDir(): string {
  return path.join(os.homedir(), '.codex', 'archived_sessions');
}

function getAllCodexSessionFiles(): string[] {
  const active = listJsonlFiles(getCodexSessionsDir());
  const archived = listJsonlFiles(getCodexArchivedSessionsDir());
  return [...active, ...archived];
}

export function parseCodexSessionContent(
  content: string,
  options: ParseCodexContentOptions = {},
): ParsedSession | null {
  const lines = content.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return null;

  const messages: ParsedMessage[] = [];
  let sessionId = '';
  let cwd = '';
  let gitBranch = '';
  let version = '';
  let preview = '';
  let createdAt = '';
  let updatedAt = '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let model = '';
  let reasoningEffort = '';
  const fallbackCreatedAt = options.createdAtFallback || new Date().toISOString();
  const fallbackUpdatedAt = options.updatedAtFallback || fallbackCreatedAt;
  const fallbackSize = options.fileSize ?? Buffer.byteLength(content, 'utf8');

  for (const line of lines) {
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      continue;
    }

    const ts = safeString(entry.timestamp);
    if (ts) {
      if (!createdAt) createdAt = ts;
      updatedAt = ts;
    }

    if (entry.type === 'session_meta') {
      const payload = toSessionMetaPayload(getEntryPayload(entry));
      if (payload.id) sessionId = payload.id;
      if (payload.cwd) cwd = cwd || payload.cwd;
      if (payload.cli_version) version = version || payload.cli_version;
      if (payload.git?.branch) gitBranch = gitBranch || payload.git.branch;
      if (!createdAt && payload.timestamp) {
        createdAt = payload.timestamp;
      }
      continue;
    }

    if (entry.type === 'turn_context') {
      const payload = toTurnContextPayload(getEntryPayload(entry));
      if (!cwd && safeString((getEntryPayload(entry) as Record<string, unknown>).cwd)) {
        cwd = safeString((getEntryPayload(entry) as Record<string, unknown>).cwd);
      }
      if (!model) {
        model = payload.model || payload.collaboration_mode?.settings?.model || '';
      }
      if (!reasoningEffort) {
        const rawEffort = payload.effort || payload.collaboration_mode?.settings?.reasoning_effort || '';
        reasoningEffort = normalizeReasoningEffort(rawEffort) || '';
      }
      continue;
    }

    if (entry.type !== 'event_msg') continue;

    const payload = toEventMessagePayload(getEntryPayload(entry));
    const msg = safeString(payload.message).trim();
    const eventType = safeString(payload.type).trim().toLowerCase();
    const timestamp = ts || updatedAt || createdAt || fallbackUpdatedAt;
    if (!msg) continue;

    if (eventType === 'user_message') {
      userMessageCount++;
      if (!preview) preview = msg.slice(0, 120);
      if (options.includeMessages) {
        messages.push({
          role: 'user',
          content: msg,
          contentBlocks: [{ type: 'text', text: msg }],
          hasToolBlocks: false,
          timestamp,
        });
      }
      continue;
    }

    if (eventType === 'agent_message' && isFinalAgentPhase(payload.phase || '')) {
      assistantMessageCount++;
      if (options.includeMessages) {
        messages.push({
          role: 'assistant',
          content: msg,
          contentBlocks: [{ type: 'text', text: msg }],
          hasToolBlocks: false,
          timestamp,
        });
      }
    }
  }

  if (userMessageCount === 0 && assistantMessageCount === 0) {
    return null;
  }

  const fallbackSessionId = options.sessionIdFallback || fallbackFileStem(options.filePath);
  const effectiveSessionId = sessionId || fallbackSessionId;
  const effectiveCwd = cwd || '';
  const projectName = effectiveCwd ? path.basename(effectiveCwd) : (fallbackSessionId || 'session');

  return {
    info: {
      sessionId: effectiveSessionId,
      projectPath: effectiveCwd,
      projectName,
      cwd: effectiveCwd,
      gitBranch,
      version,
      preview: preview || '(no preview)',
      userMessageCount,
      assistantMessageCount,
      createdAt: createdAt || fallbackCreatedAt,
      updatedAt: updatedAt || fallbackUpdatedAt,
      fileSize: fallbackSize,
      model,
      reasoningEffort,
      engineType: 'codex',
    },
    messages,
  };
}

function parseCodexFile(filePath: string, includeMessages: boolean): ParsedSession | null {
  const result = readJsonlLines(filePath);
  if (!result) return null;
  const { lines, stat } = result;
  return parseCodexSessionContent(lines.join('\n'), {
    includeMessages,
    filePath,
    fileSize: stat.size,
    createdAtFallback: stat.birthtime.toISOString(),
    updatedAtFallback: stat.mtime.toISOString(),
    sessionIdFallback: path.basename(filePath, '.jsonl'),
  });
}

export function listCodexSessions(): CodexSessionInfo[] {
  const files = getAllCodexSessionFiles();
  const sessions: CodexSessionInfo[] = [];

  for (const filePath of files) {
    try {
      const parsed = parseCodexFile(filePath, false);
      if (parsed) {
        sessions.push(parsed.info);
      }
    } catch {
      // Ignore unparseable session files.
    }
  }

  sessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return sessions;
}

export function parseCodexSession(sessionId: string): ParsedSession | null {
  const files = getAllCodexSessionFiles();
  if (files.length === 0) return null;

  const likely = files.filter((filePath) =>
    path.basename(filePath, '.jsonl').includes(sessionId),
  );
  const candidates = likely.length > 0 ? likely : files;

  for (const filePath of candidates) {
    try {
      const parsed = parseCodexFile(filePath, true);
      if (parsed && parsed.info.sessionId === sessionId) {
        return parsed;
      }
    } catch {
      // Continue scanning.
    }
  }

  // Fallback: if user passed a full filename stem instead of payload.id
  for (const filePath of files) {
    if (path.basename(filePath, '.jsonl') !== sessionId) continue;
    try {
      const parsed = parseCodexFile(filePath, true);
      if (parsed) return parsed;
    } catch {
      // Ignore.
    }
  }

  return null;
}
