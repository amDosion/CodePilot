'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ShellTranscriptList } from '@/components/chat/ShellTranscriptList';
import { useTranslation } from '@/hooks/useTranslation';
import { ConnectionHealthIndicator } from '@/components/remote/ConnectionHealthIndicator';
import { ConnectionReconnectBanner } from '@/components/remote/ConnectionReconnectBanner';
import type { RemoteShellState, ShellTranscriptEntry, ShellTranscriptResponse } from '@/types';

interface RemoteShellViewProps {
  sessionId: string;
  remotePath: string;
  workingDirectory: string;
  remoteConnectionId: string;
  initialTranscriptEntries?: ShellTranscriptEntry[];
  initialTranscriptHasMore?: boolean;
}

type XTerminal = import('@xterm/xterm').Terminal;
type XFitAddon = import('@xterm/addon-fit').FitAddon;

function normalizeState(value: string | null | undefined): RemoteShellState {
  if (value === 'starting' || value === 'running' || value === 'stopped' || value === 'error') {
    return value;
  }
  return 'idle';
}

export function RemoteShellView(props: RemoteShellViewProps) {
  const {
    sessionId,
    remotePath,
    remoteConnectionId,
    initialTranscriptEntries = [],
    initialTranscriptHasMore = false,
  } = props;
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const refreshTranscriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshingTranscriptRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const reportedSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const autoStartedRef = useRef(false);

  const [shellState, setShellState] = useState<RemoteShellState>('idle');
  const [connected, setConnected] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [transcriptEntries, setTranscriptEntries] = useState<ShellTranscriptEntry[]>(initialTranscriptEntries);
  const [hasMoreTranscript, setHasMoreTranscript] = useState(initialTranscriptHasMore);
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewMode, setViewMode] = useState<'shell' | 'transcript'>('shell');
  const [shellReady, setShellReady] = useState(false);

  const isActive = shellState === 'starting' || shellState === 'running';

  // Keystroke batching refs (used inside xterm onData — no React dep needed)
  const inputBufRef = useRef('');
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const reportShellSize = useCallback((cols: number, rows: number) => {
    if (!remoteConnectionId || !remotePath) return;

    const nextCols = Math.max(20, Math.floor(cols));
    const nextRows = Math.max(10, Math.floor(rows));
    const previous = reportedSizeRef.current;
    if (previous && previous.cols === nextCols && previous.rows === nextRows) {
      return;
    }

    reportedSizeRef.current = { cols: nextCols, rows: nextRows };
    fetch(`/api/chat/sessions/${sessionIdRef.current}/remote-shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resize', cols: nextCols, rows: nextRows }),
    }).catch(() => {});
  }, [remoteConnectionId, remotePath]);

  const refreshTranscript = useCallback(async () => {
    if (refreshingTranscriptRef.current) return;
    refreshingTranscriptRef.current = true;
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/shell-transcript?limit=100`);
      if (!res.ok) return;
      const data = await res.json() as ShellTranscriptResponse;
      setTranscriptEntries(Array.isArray(data.entries) ? data.entries : []);
      setHasMoreTranscript(Boolean(data.hasMore));
    } catch {
      // ignore refresh errors
    } finally {
      refreshingTranscriptRef.current = false;
    }
  }, [sessionId]);

  const scheduleTranscriptRefresh = useCallback((immediate = false) => {
    if (immediate) {
      if (refreshTranscriptTimerRef.current !== null) {
        clearTimeout(refreshTranscriptTimerRef.current);
        refreshTranscriptTimerRef.current = null;
      }
      void refreshTranscript();
      return;
    }

    if (refreshTranscriptTimerRef.current !== null) return;
    refreshTranscriptTimerRef.current = setTimeout(() => {
      refreshTranscriptTimerRef.current = null;
      void refreshTranscript();
    }, 700);
  }, [refreshTranscript]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreTranscript || transcriptEntries.length === 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const earliest = transcriptEntries[0];
      const earliestRowId = earliest._rowid;
      if (typeof earliestRowId !== 'number') return;

      const res = await fetch(`/api/chat/sessions/${sessionId}/shell-transcript?limit=100&before=${earliestRowId}`);
      if (!res.ok) return;
      const data = await res.json() as ShellTranscriptResponse;
      if (Array.isArray(data.entries) && data.entries.length > 0) {
        setTranscriptEntries((prev) => [...data.entries!, ...prev]);
      }
      setHasMoreTranscript(Boolean(data.hasMore));
    } catch {
      // ignore pagination errors
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMoreTranscript, transcriptEntries, sessionId]);

  // ── Shell action helper ─────────────────────────────────────────────
   
  const shellAction = useCallback(async (action: 'start' | 'stop' | 'clear') => {
    try {
      setStatusMessage('');
      const res = await fetch(`/api/chat/sessions/${sessionIdRef.current}/remote-shell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Action failed');
      if (action === 'clear') {
        termRef.current?.reset();
      }
      scheduleTranscriptRefresh(action !== 'start');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Action failed');
      if (action === 'start') setShellState('error');
    }
  }, [scheduleTranscriptRefresh]);

  // ── Initialize xterm.js (dynamic import to avoid SSR issues) ───────
  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let terminal: XTerminal | null = null;
    let fitAddon: XFitAddon | null = null;
    let inputDisposable: { dispose(): void } | null = null;
    let resizeObserver: ResizeObserver | null = null;

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([xtermMod, fitMod]) => {
      if (disposed || !containerRef.current) return;

      const fitTerminal = () => {
        try {
          fitAddon?.fit();
          if (terminal) {
            terminal.refresh(0, Math.max(terminal.rows - 1, 0));
            const containerWidth = containerRef.current?.clientWidth ?? 0;
            const containerHeight = containerRef.current?.clientHeight ?? 0;
            if (containerWidth >= 200 && containerHeight >= 120) {
              reportShellSize(terminal.cols, terminal.rows);
              setShellReady(true);
            }
          }
        } catch {
          // ignore transient layout races
        }
      };

      terminal = new xtermMod.Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'SF Mono', 'Monaco', 'Menlo', 'Consolas', 'Liberation Mono', monospace",
        scrollback: 10000,
        theme: {
          background: '#09090b',
          foreground: '#f4f4f5',
          cursor: '#f4f4f5',
          selectionBackground: '#3f3f46',
          black: '#09090b',
          red: '#ef4444',
          green: '#22c55e',
          yellow: '#eab308',
          blue: '#3b82f6',
          magenta: '#a855f7',
          cyan: '#06b6d4',
          white: '#f4f4f5',
          brightBlack: '#52525b',
          brightRed: '#f87171',
          brightGreen: '#4ade80',
          brightYellow: '#facc15',
          brightBlue: '#60a5fa',
          brightMagenta: '#c084fc',
          brightCyan: '#22d3ee',
          brightWhite: '#ffffff',
        },
      });

      fitAddon = new fitMod.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current!);
      fitAddon.fit();

      termRef.current = terminal;
      fitRef.current = fitAddon;

      requestAnimationFrame(() => fitTerminal());
      requestAnimationFrame(() => requestAnimationFrame(() => fitTerminal()));
      if (typeof document !== 'undefined' && 'fonts' in document) {
        void (document.fonts.ready.then(() => {
          if (!disposed) {
            fitTerminal();
          }
        }));
      }

      // Capture input from xterm.js → batch → send to PTY
      inputDisposable = terminal.onData((data: string) => {
        inputBufRef.current += data;
        if (inputTimerRef.current !== null) return;
        inputTimerRef.current = setTimeout(() => {
          const buffered = inputBufRef.current;
          inputBufRef.current = '';
          inputTimerRef.current = null;
          if (!buffered) return;
          fetch(`/api/chat/sessions/${sessionIdRef.current}/remote-shell`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'input', data: buffered }),
          })
            .then((res) => {
              if (res.ok && /[\r\n]/.test(buffered)) {
                scheduleTranscriptRefresh(true);
              }
            })
            .catch(() => {});
        }, 16);
      });

      // Auto-resize on container resize
      resizeObserver = new ResizeObserver(() => {
        fitTerminal();
      });
      resizeObserver.observe(containerRef.current!);
    });

    return () => {
      disposed = true;
      inputDisposable?.dispose();
      resizeObserver?.disconnect();
      terminal?.dispose();
      termRef.current = null;
      fitRef.current = null;
      if (inputTimerRef.current !== null) {
        clearTimeout(inputTimerRef.current);
        inputTimerRef.current = null;
      }
    };
  }, [reportShellSize, scheduleTranscriptRefresh, sessionId]);

  // ── SSE connection for streaming output ────────────────────────────
  useEffect(() => {
    sseRef.current?.close();

    const source = new EventSource(`/api/chat/sessions/${sessionId}/remote-shell`);
    sseRef.current = source;

    source.onopen = () => setConnected(true);
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setConnected(false);
      }
    };

    source.addEventListener('snapshot', (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as {
          output?: string;
          state?: string;
          exitCode?: number | null;
          signal?: string | null;
          startedAt?: string | null;
          message?: string | null;
        };
        if (typeof payload.output === 'string' && payload.output) {
          termRef.current?.write(payload.output);
        }
        setConnected(true);
        setShellState(normalizeState(payload.state));
        if (typeof payload.output === 'string' && payload.output) {
          scheduleTranscriptRefresh();
        }
      } catch { /* ignore */ }
    });

    source.addEventListener('status', (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as {
          output?: string;
          state?: string;
          exitCode?: number | null;
          signal?: string | null;
          startedAt?: string | null;
          message?: string | null;
        };
        // Status events may carry a full output reset (e.g. after clear)
        if (typeof payload.output === 'string') {
          termRef.current?.reset();
          if (payload.output) {
            termRef.current?.write(payload.output);
          }
        }
        setConnected(true);
        setShellState(normalizeState(payload.state));
        scheduleTranscriptRefresh();
      } catch { /* ignore */ }
    });

    source.addEventListener('output', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { chunk?: string };
        if (typeof data.chunk === 'string' && data.chunk) {
          setConnected(true);
          termRef.current?.write(data.chunk);
          scheduleTranscriptRefresh();
        }
      } catch { /* ignore */ }
    });

    source.addEventListener('heartbeat', () => {
      setConnected(true);
    });

    return () => {
      source.close();
      if (sseRef.current === source) sseRef.current = null;
      setConnected(false);
    };
  }, [sessionId]);

  useEffect(() => {
    return () => {
      if (refreshTranscriptTimerRef.current !== null) {
        clearTimeout(refreshTranscriptTimerRef.current);
        refreshTranscriptTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    void refreshTranscript();
  }, [refreshTranscript]);

  // ── Auto-start shell on mount ──────────────────────────────────────
  useEffect(() => {
    if (!shellReady || autoStartedRef.current) return;
    if (remoteConnectionId && remotePath) {
      autoStartedRef.current = true;
      void shellAction('start');
    }
  }, [remoteConnectionId, remotePath, shellAction, shellReady]);

  // ── Focus terminal when shell becomes active ──────────────────────
  useEffect(() => {
    if (shellState === 'running' && connected) {
      termRef.current?.focus();
    }
  }, [shellState, connected]);

  useEffect(() => {
    if (viewMode !== 'shell') return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        if (termRef.current) {
          reportShellSize(termRef.current.cols, termRef.current.rows);
        }
      } catch {
        // ignore resize races when the container has just become visible
      }
      if (shellState === 'running' && connected) {
        termRef.current?.focus();
      }
    });
  }, [connected, reportShellSize, shellState, viewMode]);

  const shellPanel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex-1 min-h-0 p-3 sm:p-4">
        <div
          ref={containerRef}
          className="remote-shell-xterm h-full w-full overflow-hidden rounded-md bg-zinc-950"
          onClick={() => termRef.current?.focus()}
        />
      </div>
    </div>
  );

  return (
    <div className="flex flex-1 min-h-0 flex-col pb-3">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {viewMode === 'shell' && (
          <div className="flex min-w-0 items-center gap-2">
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-foreground/80">SSH</span>
            {remoteConnectionId && (
              <ConnectionHealthIndicator connectionId={remoteConnectionId} compact />
            )}
            <span className="min-w-0 truncate text-sm text-muted-foreground">{remotePath}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {viewMode === 'shell' && !isActive && (
            <Button
              variant="secondary"
              size="sm"
              className="h-8"
              onClick={() => void shellAction('start')}
              disabled={!remoteConnectionId || !remotePath}
            >
              {t('remoteDev.startShell')}
            </Button>
          )}
          {viewMode === 'shell' && isActive && (
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => void shellAction('stop')}
            >
              {t('remoteDev.stopShell')}
            </Button>
          )}
          {viewMode === 'shell' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => void shellAction('clear')}
            >
              Clear
            </Button>
          )}
          <Tabs value={viewMode} onValueChange={(value) => setViewMode(value as 'shell' | 'transcript')} className="gap-0">
            <TabsList variant="line">
              <TabsTrigger value="shell">{t('remoteDev.shellTab')}</TabsTrigger>
              <TabsTrigger value="transcript">{t('remoteDev.transcriptTab')}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {viewMode === 'shell' && remoteConnectionId && (
        <div className="mb-3">
          <ConnectionReconnectBanner connectionId={remoteConnectionId} />
        </div>
      )}

      {viewMode === 'shell' && statusMessage && (
        <div className="mb-3 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2">
          <p className="text-xs text-red-400">{statusMessage}</p>
        </div>
      )}

      <div className={viewMode === 'transcript' ? 'flex min-h-0 flex-1 overflow-hidden' : 'hidden min-h-0 flex-1 overflow-hidden'}>
        <ShellTranscriptList
          entries={transcriptEntries}
          hasMore={hasMoreTranscript}
          loadingMore={loadingMore}
          onLoadMore={handleLoadMore}
        />
      </div>

      <div className={viewMode === 'shell' ? 'flex-1 min-h-0 overflow-hidden' : 'hidden flex-1 min-h-0 overflow-hidden'}>
        {shellPanel}
      </div>
    </div>
  );
}
