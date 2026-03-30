'use client';

import { useEffect, useState, useCallback, use, useRef } from 'react';
import Link from 'next/link';
import type { Message, MessagesResponse, ChatSession } from '@/types';
import { ChatView } from '@/components/chat/ChatView';
import { RemoteShellView } from '@/components/chat/RemoteShellView';
import { HugeiconsIcon } from '@hugeicons/react';
import { StructureFolderIcon } from '@hugeicons/core-free-icons';
import { Loading02Icon, PencilEdit01Icon, Menu01Icon } from '@hugeicons/core-free-icons';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePanel } from '@/hooks/usePanel';
import { useTranslation } from '@/hooks/useTranslation';
import { normalizeEngineType } from '@/lib/engine-defaults';
import {
  buildEnginePreferenceTarget,
  persistEnginePreferences,
  readEnginePreferences,
} from '@/lib/engine-preferences';

interface ChatSessionPageProps {
  params: Promise<{ id: string }>;
}

export default function ChatSessionPage({ params }: ChatSessionPageProps) {
  const { id } = use(params);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionResolved, setSessionResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('');
  const [sessionModel, setSessionModel] = useState('');
  const [sessionProviderId, setSessionProviderId] = useState('');
  const [sessionEngineType, setSessionEngineType] = useState('claude');
  const [sessionReasoningEffort, setSessionReasoningEffort] = useState('');
  const [sessionMode, setSessionMode] = useState('');
  const [projectName, setProjectName] = useState('');
  const [sessionWorkingDir, setSessionWorkingDir] = useState('');
  const [sessionWorkspaceTransport, setSessionWorkspaceTransport] = useState<'local' | 'ssh_direct'>('local');
  const [sessionRemotePath, setSessionRemotePath] = useState('');
  const [sessionRemoteConnectionId, setSessionRemoteConnectionId] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const { panelOpen, setWorkingDirectory, setSessionId, setSessionTitle: setPanelSessionTitle, setPanelOpen, setWorkspaceMode, setRemoteConnectionId, toggleChatList } = usePanel();
  const { t } = useTranslation();

  const isRemoteWorkspace = sessionWorkspaceTransport === 'ssh_direct';
  const shouldUseRemoteShellView = isRemoteWorkspace && sessionEngineType !== 'codex';
  const handleStartEditTitle = useCallback(() => {
    setEditTitle(sessionTitle || t('chat.newConversation'));
    setIsEditingTitle(true);
  }, [sessionTitle, t]);

  const handleSaveTitle = useCallback(async () => {
    const trimmed = editTitle.trim();
    if (!trimmed) {
      setIsEditingTitle(false);
      return;
    }
    try {
      const res = await fetch(`/api/chat/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (res.ok) {
        setSessionTitle(trimmed);
        setPanelSessionTitle(trimmed);
        window.dispatchEvent(new CustomEvent('session-updated', { detail: { id, title: trimmed } }));
      }
    } catch {
      // silently fail
    }
    setIsEditingTitle(false);
  }, [editTitle, id, setPanelSessionTitle]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveTitle();
    } else if (e.key === 'Escape') {
      setIsEditingTitle(false);
    }
  }, [handleSaveTitle]);

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const res = await fetch(`/api/chat/sessions/${id}`);
        if (cancelled || !res.ok) return;

        const data: { session: ChatSession } = await res.json();
        if (cancelled) return;

        const workingDirectory = data.session.working_directory || '';
        const wt = data.session.workspace_transport;
        const isRemote = wt === 'ssh_direct';

        setSessionWorkingDir(workingDirectory);
        setSessionWorkspaceTransport(isRemote ? 'ssh_direct' : 'local');
        setSessionRemotePath(data.session.remote_path || '');
        setSessionRemoteConnectionId(data.session.remote_connection_id || '');

        // Sync workspace mode so FileTree and other components know whether to use remote APIs
        setWorkspaceMode(isRemote ? 'remote' : 'local');
        setRemoteConnectionId(isRemote ? (data.session.remote_connection_id || '') : '');

        if (workingDirectory) {
          setWorkingDirectory(workingDirectory);
          if (!isRemote) {
            localStorage.setItem('codepilot:last-working-directory', workingDirectory);
          }
          window.dispatchEvent(new Event('refresh-file-tree'));
        }

        setSessionId(id);
        setPanelOpen(true);

        const title = data.session.title || t('chat.newConversation');
        setSessionTitle(title);
        setPanelSessionTitle(title);

        const loadedEngineType = normalizeEngineType(data.session.engine_type || 'claude');
        const preferenceTarget = buildEnginePreferenceTarget(
          isRemote ? 'remote' : 'local',
          data.session.remote_connection_id || '',
        );
        const storedPreferences = readEnginePreferences(loadedEngineType, preferenceTarget);
        const loadedModel = data.session.model || storedPreferences.model;
        const loadedProviderId = data.session.provider_id || ((loadedEngineType === 'codex' || loadedEngineType === 'gemini') ? 'env' : '');

        setSessionModel(loadedModel);
        setSessionProviderId(loadedProviderId);
        setSessionEngineType(loadedEngineType);
        setSessionReasoningEffort(data.session.reasoning_effort || '');
        setSessionMode(data.session.mode || 'code');
        setProjectName(data.session.project_name || '');

        if (typeof window !== 'undefined') {
          persistEnginePreferences(loadedEngineType, {
            model: loadedModel,
            providerId: loadedProviderId,
            reasoningEffort: data.session.reasoning_effort || storedPreferences.reasoningEffort,
          }, preferenceTarget);
          window.dispatchEvent(new Event('engine-changed'));
        }
      } catch {
        // Session info load failed - panel will still work without directory
      } finally {
        if (!cancelled) {
          setSessionResolved(true);
        }
      }
    }

    void loadSession();
    return () => {
      cancelled = true;
    };
  }, [id, setPanelOpen, setPanelSessionTitle, setRemoteConnectionId, setSessionId, setWorkingDirectory, setWorkspaceMode, t]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setMessages([]);
    setHasMore(false);

    let cancelled = false;

    async function loadMessages() {
      try {
        const res = await fetch(`/api/chat/sessions/${id}/messages?limit=30`);
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 404) {
            setError('Session not found');
            return;
          }
          throw new Error('Failed to load messages');
        }
        const data: MessagesResponse = await res.json();
        if (cancelled) return;
        setMessages(data.messages);
        setHasMore(data.hasMore ?? false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load messages');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadMessages();

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading || !sessionResolved) {
    return (
      <div className="flex h-full items-center justify-center">
        <HugeiconsIcon icon={Loading02Icon} className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-destructive font-medium">{error}</p>
          <Link href="/chat" className="text-sm text-muted-foreground hover:underline">
            Start a new chat
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {sessionTitle && (
        <div
          className="flex h-12 shrink-0 items-center justify-center px-4 gap-1 relative"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <button
            onClick={toggleChatList}
            className="lg:hidden absolute left-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted transition-colors"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <HugeiconsIcon icon={Menu01Icon} className="h-4 w-4 text-muted-foreground" />
          </button>
          {projectName && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="text-xs text-muted-foreground shrink-0 hover:text-foreground transition-colors cursor-pointer"
                    style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    onClick={() => {
                      if (!sessionWorkingDir) return;
                      if (window.electronAPI?.shell?.openPath) {
                        window.electronAPI.shell.openPath(sessionWorkingDir);
                      } else {
                        fetch('/api/files/open', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ session_id: id }),
                        }).catch(() => {});
                      }
                    }}
                  >
                    {projectName}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {isRemoteWorkspace ? (
                    <>
                      <p className="text-xs break-all">{t('chat.remotePath')}: {sessionRemotePath || projectName}</p>
                    </>
                  ) : (
                    <>
                      <p className="text-xs break-all">{sessionWorkingDir || projectName}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{t('chat.openProjectHint')}</p>
                    </>
                  )}
                </TooltipContent>
              </Tooltip>
              <span className="text-xs text-muted-foreground shrink-0">/</span>
            </>
          )}
          {isEditingTitle ? (
            <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              <Input
                ref={titleInputRef}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleTitleKeyDown}
                onBlur={handleSaveTitle}
                className="h-7 text-sm max-w-md text-center"
              />
            </div>
          ) : (
            <div
              className="flex items-center gap-1 group cursor-default max-w-md"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <h2 className="text-sm font-medium text-foreground/80 truncate">
                {sessionTitle}
              </h2>
              <button
                onClick={handleStartEditTitle}
                className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-0.5 rounded hover:bg-muted"
              >
                <HugeiconsIcon icon={PencilEdit01Icon} className="h-3 w-3 text-muted-foreground" />
              </button>
            </div>
          )}
          {!panelOpen && (
            <button
              onClick={() => setPanelOpen(true)}
              className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted transition-colors"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              title="Open panel"
            >
              <HugeiconsIcon icon={StructureFolderIcon} className="h-4 w-4 text-muted-foreground" />
            </button>
          )}
        </div>
      )}
      {shouldUseRemoteShellView ? (
        <RemoteShellView
          key={id}
          sessionId={id}
          remotePath={sessionRemotePath}
          workingDirectory={sessionWorkingDir}
          remoteConnectionId={sessionRemoteConnectionId}
        />
      ) : (
        <ChatView
          key={id}
          sessionId={id}
          initialMessages={messages}
          initialHasMore={hasMore}
          modelName={sessionModel}
          initialMode={sessionMode}
          providerId={sessionProviderId}
          engineType={sessionEngineType}
          reasoningEffort={sessionReasoningEffort}
          workspaceTransport={sessionWorkspaceTransport}
          remoteConnectionId={sessionRemoteConnectionId}
        />
      )}
    </div>
  );
}
