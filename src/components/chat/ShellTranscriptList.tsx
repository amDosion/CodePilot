'use client';

import { useEffect, useRef } from 'react';
import type { ShellTranscriptEntry } from '@/types';
import { useTranslation } from '@/hooks/useTranslation';
import { cn, parseDBDate } from '@/lib/utils';
import { sanitizeShellTranscriptOutput } from '@/lib/shell-transcript';

interface ShellTranscriptListProps {
  entries: ShellTranscriptEntry[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

function formatTime(value: string): string {
  return parseDBDate(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ShellTranscriptList({
  entries,
  hasMore,
  loadingMore,
  onLoadMore,
}: ShellTranscriptListProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorIdRef = useRef<string | null>(null);
  const prevCountRef = useRef(entries.length);
  const didInitialScrollRef = useRef(false);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      prevCountRef.current = entries.length;
      return;
    }

    if (anchorIdRef.current && entries.length >= prevCountRef.current) {
      const el = document.getElementById(`shell-transcript-${anchorIdRef.current}`);
      if (el) {
        el.scrollIntoView({ block: 'start' });
      }
      anchorIdRef.current = null;
      prevCountRef.current = entries.length;
      return;
    }

    if (!didInitialScrollRef.current && entries.length > 0) {
      container.scrollTop = container.scrollHeight;
      didInitialScrollRef.current = true;
      prevCountRef.current = entries.length;
      return;
    }

    if (entries.length > prevCountRef.current) {
      container.scrollTop = container.scrollHeight;
    }
    prevCountRef.current = entries.length;
  }, [entries]);

  const handleLoadMore = () => {
    if (entries.length > 0) {
      anchorIdRef.current = entries[0]?.id ?? null;
    }
    onLoadMore?.();
  };

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/10 px-6 py-10">
        <p className="text-sm text-muted-foreground">{t('remoteDev.transcriptEmpty')}</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border/60 bg-background">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-4 sm:px-6">
        {hasMore && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {loadingMore ? t('messageList.loading') : t('messageList.loadEarlier')}
            </button>
          </div>
        )}

        {entries.map((entry) => {
          if (entry.kind === 'command') {
            return (
              <div
                key={entry.id}
                id={`shell-transcript-${entry.id}`}
                className="ml-auto w-full max-w-2xl rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-3"
              >
                <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>{t('remoteDev.transcriptCommand')}</span>
                  <span>{formatTime(entry.created_at)}</span>
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">{entry.command || ''}</pre>
                {entry.remote_path && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {t('chat.remotePath')}: {entry.remote_path}
                  </p>
                )}
              </div>
            );
          }

          const stateLabel = entry.state === 'error'
            ? t('chat.terminalError')
            : entry.state === 'stopped'
              ? t('remoteDev.commandStopped')
              : t('chat.terminalRunning');

          const output = sanitizeShellTranscriptOutput(entry.output).trimEnd() || t('chat.terminalNoOutput');

          return (
            <div
              key={entry.id}
              id={`shell-transcript-${entry.id}`}
              className="w-full rounded-lg border border-border/60 bg-muted/10"
            >
              <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-xs">
                <span className="font-medium text-foreground">{t('remoteDev.transcriptOutput')}</span>
                <span
                  className={cn(
                    'inline-flex rounded-full px-2 py-0.5',
                    entry.state === 'error'
                      ? 'bg-red-500/10 text-red-400'
                      : entry.state === 'stopped'
                        ? 'bg-zinc-500/10 text-zinc-400'
                        : 'bg-blue-500/10 text-blue-400',
                  )}
                >
                  {stateLabel}
                </span>
                <span className="text-muted-foreground">{formatTime(entry.created_at)}</span>
                {entry.command && (
                  <span className="truncate text-muted-foreground">
                    {entry.command}
                  </span>
                )}
              </div>

              {entry.remote_path && (
                <p className="px-3 pt-2 text-[11px] text-muted-foreground">
                  {t('chat.remotePath')}: {entry.remote_path}
                </p>
              )}

              <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-sm leading-6 text-foreground">
                {output}
              </pre>

              {entry.truncated && (
                <p className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
                  {t('remoteDev.transcriptTruncated')}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
