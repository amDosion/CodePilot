import type { ChatSession, RemoteConnection, RemoteShellState } from '@/types';
import {
  addShellTranscriptCommand,
  addShellTranscriptOutput,
  updateShellTranscriptOutput,
} from '@/lib/db';
import { markRemoteConnectionSuccess } from '@/lib/remote-connections';
import { spawnRemoteShell, type RemoteShellProcess } from '@/lib/remote-ssh';

export interface RemoteShellSnapshot {
  sessionId: string;
  state: RemoteShellState;
  output: string;
  startedAt: string | null;
  updatedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  message: string | null;
}

export interface RemoteShellEvent {
  type: 'snapshot' | 'output' | 'status';
  data: RemoteShellSnapshot | { chunk: string };
}

interface RemoteShellEntry {
  sessionId: string;
  snapshot: RemoteShellSnapshot;
  child: RemoteShellProcess | null;
  listeners: Set<(event: RemoteShellEvent) => void>;
  gcTimer: NodeJS.Timeout | null;
  transcriptEntryId: string | null;
  transcriptFlushTimer: NodeJS.Timeout | null;
  transcriptOutput: string;
  transcriptCommand: string | null;
  remotePath: string | null;
  inputLineBuffer: string;
  outputTruncated: boolean;
  cols: number;
  rows: number;
}

const GLOBAL_KEY = '__codepilot_remote_shell_manager__' as const;
const GC_MS = 10 * 60 * 1000;
const MAX_SHELL_OUTPUT_CHARS = 200_000;
const DEFAULT_SHELL_COLS = 120;
const DEFAULT_SHELL_ROWS = 32;

function getEntries(): Map<string, RemoteShellEntry> {
  if (!(globalThis as Record<string, unknown>)[GLOBAL_KEY]) {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = new Map<string, RemoteShellEntry>();
  }
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, RemoteShellEntry>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createSnapshot(sessionId: string): RemoteShellSnapshot {
  return {
    sessionId,
    state: 'idle',
    output: '',
    startedAt: null,
    updatedAt: null,
    exitCode: null,
    signal: null,
    message: null,
  };
}

function normalizeTerminalSize(
  cols: number | null | undefined,
  rows: number | null | undefined,
): { cols: number; rows: number } {
  const nextCols = Number.isFinite(cols) ? Math.max(20, Math.floor(cols as number)) : DEFAULT_SHELL_COLS;
  const nextRows = Number.isFinite(rows) ? Math.max(10, Math.floor(rows as number)) : DEFAULT_SHELL_ROWS;
  return {
    cols: nextCols,
    rows: nextRows,
  };
}

function cloneSnapshot(snapshot: RemoteShellSnapshot): RemoteShellSnapshot {
  return {
    ...snapshot,
  };
}

function ensureEntry(sessionId: string): RemoteShellEntry {
  const entries = getEntries();
  let entry = entries.get(sessionId);
  if (!entry) {
    entry = {
      sessionId,
      snapshot: createSnapshot(sessionId),
      child: null,
      listeners: new Set(),
      gcTimer: null,
      transcriptEntryId: null,
      transcriptFlushTimer: null,
      transcriptOutput: '',
      transcriptCommand: null,
      remotePath: null,
      inputLineBuffer: '',
      outputTruncated: false,
      cols: DEFAULT_SHELL_COLS,
      rows: DEFAULT_SHELL_ROWS,
    };
    entries.set(sessionId, entry);
  }
  return entry;
}

function clearTranscriptFlush(entry: RemoteShellEntry): void {
  if (!entry.transcriptFlushTimer) return;
  clearTimeout(entry.transcriptFlushTimer);
  entry.transcriptFlushTimer = null;
}

function resetTranscript(entry: RemoteShellEntry): void {
  clearTranscriptFlush(entry);
  entry.transcriptEntryId = null;
  entry.transcriptOutput = '';
  entry.transcriptCommand = null;
  entry.outputTruncated = false;
}

function buildTranscriptPayload(entry: RemoteShellEntry) {
  return {
    command: entry.transcriptCommand,
    remotePath: entry.remotePath ?? null,
    startedAt: entry.snapshot.startedAt ?? null,
    state: entry.snapshot.state,
    exitCode: entry.snapshot.exitCode,
    signal: entry.snapshot.signal,
    status: entry.snapshot.message,
    truncated: entry.outputTruncated,
    output: entry.transcriptOutput.trimEnd() || '(no shell output)',
  };
}

function persistTranscript(entry: RemoteShellEntry): void {
  clearTranscriptFlush(entry);
  if (!entry.transcriptOutput.trim()) {
    return;
  }

  const payload = buildTranscriptPayload(entry);
  if (!entry.transcriptEntryId) {
    const transcriptEntry = addShellTranscriptOutput(entry.sessionId, payload);
    entry.transcriptEntryId = transcriptEntry.id;
    return;
  }

  updateShellTranscriptOutput(entry.transcriptEntryId, payload);
}

function scheduleTranscriptPersist(entry: RemoteShellEntry): void {
  if (entry.transcriptFlushTimer) return;
  entry.transcriptFlushTimer = setTimeout(() => {
    persistTranscript(entry);
  }, 400);
  entry.transcriptFlushTimer.unref?.();
}

function emit(entry: RemoteShellEntry, event: RemoteShellEvent): void {
  for (const listener of entry.listeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[remote-shell] listener error:', error);
    }
  }
}

function clearGc(entry: RemoteShellEntry): void {
  if (!entry.gcTimer) return;
  clearTimeout(entry.gcTimer);
  entry.gcTimer = null;
}

function scheduleGc(entry: RemoteShellEntry): void {
  clearGc(entry);
  if (entry.child || entry.listeners.size > 0) return;
  entry.gcTimer = setTimeout(() => {
    const current = getEntries().get(entry.sessionId);
    if (!current) return;
    if (current.child || current.listeners.size > 0) return;
    getEntries().delete(entry.sessionId);
  }, GC_MS);
  entry.gcTimer.unref?.();
}

function publishSnapshot(entry: RemoteShellEntry, type: 'snapshot' | 'status'): void {
  emit(entry, { type, data: cloneSnapshot(entry.snapshot) });
}

function updateSnapshot(entry: RemoteShellEntry, patch: Partial<RemoteShellSnapshot>, type: 'snapshot' | 'status' = 'status'): void {
  entry.snapshot = {
    ...entry.snapshot,
    ...patch,
    updatedAt: nowIso(),
  };
  publishSnapshot(entry, type);
}

function appendOutput(entry: RemoteShellEntry, chunk: string): void {
  if (!chunk) return;
  const combinedSnapshot = `${entry.snapshot.output}${chunk}`;
  entry.snapshot.output = combinedSnapshot.length > MAX_SHELL_OUTPUT_CHARS ? combinedSnapshot.slice(-MAX_SHELL_OUTPUT_CHARS) : combinedSnapshot;
  const combinedTranscript = `${entry.transcriptOutput}${chunk}`;
  entry.outputTruncated = combinedTranscript.length > MAX_SHELL_OUTPUT_CHARS || entry.outputTruncated;
  entry.transcriptOutput = combinedTranscript.length > MAX_SHELL_OUTPUT_CHARS ? combinedTranscript.slice(-MAX_SHELL_OUTPUT_CHARS) : combinedTranscript;
  entry.snapshot.updatedAt = nowIso();
  emit(entry, { type: 'output', data: { chunk } });
  scheduleTranscriptPersist(entry);
}

function extractSubmittedCommands(entry: RemoteShellEntry, data: string): string[] {
  const commands: string[] = [];
  const normalized = data
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001bO./g, '')
    .replace(/\u001b/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  for (const char of normalized) {
    if (char === '\n') {
      const command = entry.inputLineBuffer.trim();
      entry.inputLineBuffer = '';
      if (command) {
        commands.push(command);
      }
      continue;
    }

    if (char === '\b' || char === '\u007f') {
      entry.inputLineBuffer = entry.inputLineBuffer.slice(0, -1);
      continue;
    }

    if (char < ' ' && char !== '\t') {
      continue;
    }

    entry.inputLineBuffer += char;
  }

  return commands;
}

export function getRemoteShellSnapshot(sessionId: string): RemoteShellSnapshot {
  return cloneSnapshot(ensureEntry(sessionId).snapshot);
}

export function subscribeRemoteShell(sessionId: string, listener: (event: RemoteShellEvent) => void): () => void {
  const entry = ensureEntry(sessionId);
  clearGc(entry);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    scheduleGc(entry);
  };
}

export async function startRemoteShell(session: ChatSession, connection: RemoteConnection): Promise<RemoteShellSnapshot> {
  const entry = ensureEntry(session.id);
  clearGc(entry);
  clearTranscriptFlush(entry);

  if (entry.child && (entry.snapshot.state === 'starting' || entry.snapshot.state === 'running')) {
    return cloneSnapshot(entry.snapshot);
  }

  const child = await spawnRemoteShell(connection, {
    cwd: session.remote_path,
    cols: entry.cols,
    rows: entry.rows,
  });
  entry.child = child;
  entry.remotePath = session.remote_path;
  entry.inputLineBuffer = '';
  resetTranscript(entry);
  entry.snapshot = {
    sessionId: session.id,
    state: 'starting',
    output: '',
    startedAt: nowIso(),
    updatedAt: nowIso(),
    exitCode: null,
    signal: null,
    message: null,
  };
  publishSnapshot(entry, 'snapshot');

  let becameRunning = false;
  const markRunning = () => {
    if (becameRunning) return;
    becameRunning = true;
    updateSnapshot(entry, {
      state: 'running',
      message: null,
      exitCode: null,
      signal: null,
    });
  };

  child.onData((chunk: string) => {
    markRunning();
    appendOutput(entry, chunk);
  });

  child.onExit(({ exitCode, signal }) => {
    entry.child = null;
    if (entry.snapshot.state !== 'error') {
      if (!becameRunning) {
        markRunning();
      }
      const normalizedSignal = typeof signal === 'number' && signal > 0 ? String(signal) : null;
      updateSnapshot(entry, {
        state: 'stopped',
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: normalizedSignal,
        message: normalizedSignal ? `signal:${normalizedSignal}` : (typeof exitCode === 'number' && exitCode !== 0 ? `exit:${exitCode}` : null),
      });
      persistTranscript(entry);
      markRemoteConnectionSuccess(connection.id);
    }
    scheduleGc(entry);
  });

  markRemoteConnectionSuccess(connection.id);
  return cloneSnapshot(entry.snapshot);
}

export function sendRemoteShellInput(sessionId: string, data: string): RemoteShellSnapshot {
  const entry = ensureEntry(sessionId);
  if (!entry.child) {
    throw new Error('Remote terminal is not running');
  }

  const commands = extractSubmittedCommands(entry, data);
  for (const command of commands) {
    persistTranscript(entry);
    resetTranscript(entry);
    entry.transcriptCommand = command;
    addShellTranscriptCommand(entry.sessionId, command, entry.remotePath);
  }

  entry.child.write(data);
  return cloneSnapshot(entry.snapshot);
}

export function resizeRemoteShell(sessionId: string, cols: number, rows: number): RemoteShellSnapshot {
  const entry = ensureEntry(sessionId);
  const nextSize = normalizeTerminalSize(cols, rows);
  entry.cols = nextSize.cols;
  entry.rows = nextSize.rows;

  if (entry.child) {
    entry.child.resize(nextSize.cols, nextSize.rows);
  }

  return cloneSnapshot(entry.snapshot);
}

export function stopRemoteShell(sessionId: string): RemoteShellSnapshot {
  const entry = ensureEntry(sessionId);
  if (entry.child) {
    entry.child.kill('SIGTERM');
  } else if (entry.snapshot.state !== 'idle' && entry.snapshot.state !== 'stopped') {
    updateSnapshot(entry, { state: 'stopped', message: null });
  }
  return cloneSnapshot(entry.snapshot);
}

export function clearRemoteShell(sessionId: string): RemoteShellSnapshot {
  const entry = ensureEntry(sessionId);
  persistTranscript(entry);
  entry.inputLineBuffer = '';
  updateSnapshot(entry, { output: '' }, 'snapshot');
  resetTranscript(entry);
  return cloneSnapshot(entry.snapshot);
}
