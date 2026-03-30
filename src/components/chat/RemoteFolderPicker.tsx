'use client';

import { useState, useEffect, useCallback } from 'react';
import { HugeiconsIcon } from "@hugeicons/react";
import { Folder01Icon, FolderOpenIcon, ArrowRight01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/hooks/useTranslation';

interface RemoteDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface RemoteFolderPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => Promise<void>;
  connectionId: string;
  initialPath?: string;
}

export function RemoteFolderPicker({ open, onOpenChange, onSelect, connectionId, initialPath }: RemoteFolderPickerProps) {
  const { t } = useTranslation();
  const [currentDir, setCurrentDir] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(async (dir: string) => {
    if (!connectionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/remote/ls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId, path: dir }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to list remote directory');
      }
      const currentPath = data.current_path || dir;
      const nextRootDir = typeof data.root_path === 'string' ? data.root_path : '';
      setCurrentDir(currentPath);
      setRootDir(nextRootDir);
      setEntries(data.entries || []);
      setPathInput(currentPath);
    } catch (error) {
      setEntries([]);
      setError(error instanceof Error ? error.message : 'Failed to list remote directory');
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (open && connectionId) {
      browse(initialPath || '~');
    }
  }, [open, connectionId, initialPath, browse]);

  const parentDir = currentDir.includes('/')
    ? currentDir.replace(/\/[^/]+$/, '') || '/'
    : '/';
  const atRootBoundary = rootDir ? currentDir === rootDir : currentDir === '/';

  const handleNavigate = (dir: string) => {
    browse(dir);
  };

  const handleGoUp = () => {
    if (!atRootBoundary) browse(parentDir);
  };

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) {
      browse(pathInput.trim());
    }
  };

  const handleSelect = async () => {
    if (!currentDir || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSelect(currentDir);
      onOpenChange(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to add remote project folder');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('folderPicker.title')} (SSH)</DialogTitle>
        </DialogHeader>

        {/* Path input */}
        <form onSubmit={handlePathSubmit} className="flex gap-2">
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="/root/project"
            className="flex-1 font-mono text-sm"
          />
          <Button type="submit" variant="outline" size="sm">
            Go
          </Button>
        </form>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {/* Directory browser */}
        <div className="rounded-md border border-border">
          {/* Current path + go up */}
          <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleGoUp}
              disabled={atRootBoundary}
              className="shrink-0"
            >
              <HugeiconsIcon icon={ArrowUp01Icon} className="h-4 w-4" />
            </Button>
            <span className="min-w-0 overflow-x-auto whitespace-nowrap text-xs font-mono text-muted-foreground">
              {currentDir}
            </span>
          </div>

          {rootDir && (
            <div className="border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
              Root: {rootDir}
            </div>
          )}

          {/* Folder list */}
          <ScrollArea className="h-64">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {t('folderPicker.loading')}
              </div>
            ) : entries.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {t('folderPicker.noSubdirs')}
              </div>
            ) : (
              <div className="p-1">
                {entries.map((entry) => (
                  <button
                    key={entry.path}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-accent transition-colors text-left"
                    onClick={() => handleNavigate(entry.path)}
                  >
                    <HugeiconsIcon icon={Folder01Icon} className="h-4 w-4 shrink-0 text-blue-500" />
                    <span className="truncate">{entry.name}</span>
                    <HugeiconsIcon icon={ArrowRight01Icon} className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('folderPicker.cancel')}
          </Button>
          <Button onClick={() => void handleSelect()} disabled={!currentDir || submitting} className="gap-2">
            <HugeiconsIcon icon={FolderOpenIcon} className="h-4 w-4" />
            {submitting ? t('common.loading') : t('folderPicker.select')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
