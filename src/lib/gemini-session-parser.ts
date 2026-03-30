import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TokenUsage } from '@/types';

const MAX_FILE_SIZE = 50 * 1024 * 1024;

interface GeminiContentPart {
  text?: string;
}

interface GeminiTokensPayload {
  input?: number;
  output?: number;
  cached?: number;
}

interface GeminiSessionMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: unknown;
  model?: string;
  tokens?: GeminiTokensPayload;
}

interface GeminiSessionFile {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiSessionMessage[];
  kind?: string;
}

export interface GeminiSessionInfo {
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
  engineType: 'gemini';
}

export interface ParsedGeminiMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  tokenUsage?: TokenUsage | null;
}

export interface ParsedGeminiSession {
  info: GeminiSessionInfo;
  messages: ParsedGeminiMessage[];
}

export function getGeminiTmpDir(): string {
  return path.join(os.homedir(), '.gemini', 'tmp');
}

function readProjectRoot(projectDir: string): string {
  const projectRootFile = path.join(projectDir, '.project_root');
  if (fs.existsSync(projectRootFile)) {
    try {
      return fs.readFileSync(projectRootFile, 'utf-8').trim() || projectDir;
    } catch {
      return projectDir;
    }
  }
  return projectDir;
}

function listGeminiSessionFiles(): string[] {
  const tmpDir = getGeminiTmpDir();
  if (!fs.existsSync(tmpDir)) return [];

  const results: string[] = [];
  try {
    const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const chatsDir = path.join(tmpDir, entry.name, 'chats');
      if (!fs.existsSync(chatsDir)) continue;

      try {
        const chatFiles = fs.readdirSync(chatsDir, { withFileTypes: true });
        for (const chatFile of chatFiles) {
          if (!chatFile.isFile() || !chatFile.name.endsWith('.json')) continue;
          results.push(path.join(chatsDir, chatFile.name));
        }
      } catch {
        // ignore per-project read failures
      }
    }
  } catch {
    return [];
  }

  return results;
}

function toTokenUsage(tokens: GeminiTokensPayload | undefined): TokenUsage | null {
  if (!tokens) return null;
  return {
    input_tokens: Number(tokens.input || 0),
    output_tokens: Number(tokens.output || 0),
    cache_read_input_tokens: Number(tokens.cached || 0),
  };
}

function extractUserText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
        return typeof (part as GeminiContentPart).text === 'string'
          ? (part as GeminiContentPart).text || ''
          : '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  return typeof content === 'string' ? content.trim() : '';
}

function parseGeminiFile(filePath: string, includeMessages: boolean): ParsedGeminiSession | null {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) return null;

  let raw: GeminiSessionFile;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as GeminiSessionFile;
  } catch {
    return null;
  }

  if (!raw || !Array.isArray(raw.messages)) return null;
  if (raw.kind && raw.kind !== 'main') return null;

  const projectDir = path.dirname(path.dirname(filePath));
  const projectPath = readProjectRoot(projectDir);
  const projectName = path.basename(projectPath || projectDir);

  let preview = '';
  let model = '';
  let createdAt = raw.startTime || '';
  let updatedAt = raw.lastUpdated || '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  const messages: ParsedGeminiMessage[] = [];

  for (const message of raw.messages) {
    const timestamp = typeof message.timestamp === 'string' ? message.timestamp : '';
    if (!createdAt && timestamp) createdAt = timestamp;
    if (timestamp) updatedAt = timestamp;

    if (message.type === 'user') {
      const content = extractUserText(message.content);
      if (!content) continue;
      userMessageCount += 1;
      if (!preview) preview = content;
      if (includeMessages) {
        messages.push({
          role: 'user',
          content,
          timestamp,
        });
      }
      continue;
    }

    if (message.type === 'gemini') {
      const content = extractUserText(message.content);
      if (!content) continue;
      assistantMessageCount += 1;
      if (!preview) preview = content;
      if (message.model) model = message.model;
      if (includeMessages) {
        messages.push({
          role: 'assistant',
          content,
          timestamp,
          tokenUsage: toTokenUsage(message.tokens),
        });
      }
    }
  }

  const sessionId = raw.sessionId || path.basename(filePath, '.json');
  const finalCreatedAt = createdAt || stat.birthtime.toISOString();
  const finalUpdatedAt = updatedAt || stat.mtime.toISOString();

  return {
    info: {
      sessionId,
      projectPath,
      projectName,
      cwd: projectPath,
      gitBranch: '',
      version: '',
      preview: preview || `Imported Gemini session from ${projectName}`,
      userMessageCount,
      assistantMessageCount,
      createdAt: finalCreatedAt,
      updatedAt: finalUpdatedAt,
      fileSize: stat.size,
      model,
      engineType: 'gemini',
    },
    messages,
  };
}

export function listGeminiSessions(): GeminiSessionInfo[] {
  return listGeminiSessionFiles()
    .map((filePath) => parseGeminiFile(filePath, false)?.info || null)
    .filter((session): session is GeminiSessionInfo => session !== null)
    .filter((session) => session.userMessageCount + session.assistantMessageCount > 0)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function parseGeminiSession(sessionId: string): ParsedGeminiSession | null {
  for (const filePath of listGeminiSessionFiles()) {
    const parsed = parseGeminiFile(filePath, true);
    if (!parsed) continue;
    if (parsed.info.sessionId === sessionId) {
      return parsed;
    }
  }
  return null;
}
