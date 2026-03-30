"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  Search01Icon,
  Notification02Icon,
  FileImportIcon,
  Folder01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  PlusSignIcon,
  FolderOpenIcon,
} from "@hugeicons/core-free-icons";
import { Columns2, Pause, Play, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn, parseDBDate } from "@/lib/utils";
import { usePanel } from "@/hooks/usePanel";
import { useSplit } from "@/hooks/useSplit";
import { useTranslation } from "@/hooks/useTranslation";
import { useNativeFolderPicker } from "@/hooks/useNativeFolderPicker";
import {
  normalizeEngineType,
} from "@/lib/engine-defaults";
import {
  buildEnginePreferenceTarget,
  readActiveEngine,
  readEnginePreferences,
  type EnginePreferenceTarget,
  type EnginePreferenceScope,
} from "@/lib/engine-preferences";
import { ConnectionStatus } from "./ConnectionStatus";
import { useDefaultModel, useDefaultReasoningEffort } from '@/hooks/useCliDefaults';
import { ImportSessionDialog } from "./ImportSessionDialog";
import { FolderPicker } from "@/components/chat/FolderPicker";
import { RemoteFolderPicker } from "@/components/chat/RemoteFolderPicker";
import type { ChatSession } from "@/types";

interface ChatListPanelProps {
  open: boolean;
  width?: number;
  onClose?: () => void;
}

function formatRelativeTime(dateStr: string, t: (key: import('@/i18n').TranslationKey, params?: Record<string, string | number>) => string): string {
  const date = parseDBDate(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return t('chatList.justNow');
  if (diffMin < 60) return t('chatList.minutesAgo', { n: diffMin });
  if (diffHr < 24) return t('chatList.hoursAgo', { n: diffHr });
  if (diffDay < 7) return t('chatList.daysAgo', { n: diffDay });
  return date.toLocaleDateString();
}

const COLLAPSED_PROJECTS_KEY = "codepilot:collapsed-projects";
const COLLAPSED_INITIALIZED_KEY = "codepilot:collapsed-initialized";
const PAUSED_PROJECTS_KEY = "codepilot:paused-project-groups";
const HIDDEN_PROJECTS_KEY = "codepilot:hidden-project-groups";

function loadCollapsedProjects(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // ignore
  }
  return new Set();
}

function saveCollapsedProjects(collapsed: Set<string>) {
  localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]));
}

function loadPausedProjects(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(PAUSED_PROJECTS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // ignore
  }
  return new Set();
}

function savePausedProjects(paused: Set<string>) {
  localStorage.setItem(PAUSED_PROJECTS_KEY, JSON.stringify([...paused]));
}

function loadHiddenProjects(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(HIDDEN_PROJECTS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // ignore
  }
  return new Set();
}

function saveHiddenProjects(hidden: Set<string>) {
  localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...hidden]));
}

interface ProjectGroup {
  groupKey: string;
  workingDirectory: string;
  displayName: string;
  sessions: ChatSession[];
  latestUpdatedAt: number;
  workspaceTransport: 'local' | 'ssh_direct';
  remoteConnectionId: string;
  remotePath: string;
  openSessionId: string;
}

type ProjectListView = 'active' | 'stopped';

function groupSessionsByProject(sessions: ChatSession[]): ProjectGroup[] {
  const map = new Map<string, ChatSession[]>();
  for (const session of sessions) {
    const key = session.workspace_transport === 'ssh_direct'
      ? `ssh_direct:${session.remote_connection_id || ''}:${session.remote_path || session.working_directory || ''}`
      : `local:${session.working_directory || ''}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(session);
  }

  const groups: ProjectGroup[] = [];
  for (const [wd, groupSessions] of map) {
    groupSessions.sort(
      (a, b) =>
        parseDBDate(b.updated_at).getTime() - parseDBDate(a.updated_at).getTime()
    );
    const primarySession = groupSessions[0];
    const effectiveWorkingDirectory = primarySession.working_directory || "";
    const displayName =
      effectiveWorkingDirectory === ""
        ? "No Project"
        : primarySession?.project_name || effectiveWorkingDirectory.split("/").pop() || effectiveWorkingDirectory;
    const latestUpdatedAt = parseDBDate(primarySession.updated_at).getTime();
    groups.push({
      groupKey: wd,
      workingDirectory: effectiveWorkingDirectory,
      displayName,
      sessions: groupSessions,
      latestUpdatedAt,
      workspaceTransport: primarySession.workspace_transport === 'ssh_direct' ? 'ssh_direct' : 'local',
      remoteConnectionId: primarySession.remote_connection_id || '',
      remotePath: primarySession.remote_path || '',
      openSessionId: primarySession.id,
    });
  }

  // Sort groups by most recently active first
  groups.sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);
  return groups;
}

export function ChatListPanel({ open, width, onClose }: ChatListPanelProps) {
  const pathname = usePathname();
  const router = useRouter();
  const {
    streamingSessionId,
    pendingApprovalSessionId,
    activeStreamingSessions,
    pendingApprovalSessionIds,
    workingDirectory,
    workspaceMode,
    setWorkspaceMode,
    setWorkingDirectory,
    setSessionId,
    remoteConnectionId,
    setRemoteConnectionReady,
    setRemoteConnectionState,
  } = usePanel();
  const { splitSessions, isSplitActive, activeColumnId, addToSplit, removeFromSplit, setActiveColumn, isInSplit } = useSplit();
  const { t } = useTranslation();
  const { isElectron, openNativePicker } = useNativeFolderPicker();
  const cliDefaultModel = useDefaultModel();
  const cliDefaultReasoning = useDefaultReasoningEffort();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [deletingSession, setDeletingSession] = useState<string | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<ChatSession | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [remoteFolderPickerOpen, setRemoteFolderPickerOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [pausedProjects, setPausedProjects] = useState<Set<string>>(new Set());
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(new Set());
  const [hoveredFolder, setHoveredFolder] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [importEngineType, setImportEngineType] = useState<"claude" | "codex" | "gemini">("claude");
  const [verifyingRemote, setVerifyingRemote] = useState(false);
  const [createSessionError, setCreateSessionError] = useState<string | null>(null);
  const [pendingDeleteProject, setPendingDeleteProject] = useState<ProjectGroup | null>(null);
  const [projectListView, setProjectListView] = useState<ProjectListView>('active');

  /** Read current model/provider/engine defaults for new session creation */
  const getCurrentSessionDefaults = useCallback((
    target: EnginePreferenceTarget | EnginePreferenceScope = 'local',
  ) => {
    const engine_type = readActiveEngine(target);
    const preferences = readEnginePreferences(engine_type, target, { model: cliDefaultModel, reasoningEffort: cliDefaultReasoning });
    const model = preferences.model || cliDefaultModel;
    const provider_id = preferences.providerId;
    const reasoning_effort = engine_type === 'codex'
      ? (preferences.reasoningEffort || cliDefaultReasoning)
      : '';
    return { model, provider_id, engine_type, reasoning_effort };
  }, []);

  const handleFolderSelect = useCallback(async (path: string) => {
    try {
      const { model, provider_id, engine_type, reasoning_effort } = getCurrentSessionDefaults(
        buildEnginePreferenceTarget('local'),
      );
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_directory: path, model, provider_id, engine_type, reasoning_effort }),
      });
      if (res.ok) {
        const data = await res.json();
        window.dispatchEvent(new CustomEvent("session-created"));
        router.push(`/chat/${data.session.id}`);
      }
    } catch {
      // Silently fail
    }
  }, [router, getCurrentSessionDefaults]);

  const handleRemoteFolderSelect = useCallback(async (path: string) => {
    const connId = remoteConnectionId
      || (typeof window !== 'undefined'
        ? localStorage.getItem('codepilot:last-remote-connection-id')
        : null);
    if (!connId) {
      const message = t('chat.remoteConnectionRequired');
      setCreateSessionError(message);
      throw new Error(message);
    }

    try {
      setCreateSessionError(null);
      const { model, provider_id, engine_type, reasoning_effort } = getCurrentSessionDefaults(
        buildEnginePreferenceTarget('remote', connId),
      );
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_transport: 'ssh_direct',
          remote_connection_id: connId,
          remote_path: path,
          model,
          provider_id,
          engine_type,
          reasoning_effort,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = typeof data?.error === 'string' && data.error
          ? data.error
          : 'Failed to create remote session';
        setCreateSessionError(message);
        throw new Error(message);
      }
      localStorage.setItem('codepilot:last-remote-path', path);
      setWorkingDirectory(path);
      window.dispatchEvent(new CustomEvent("session-created"));
      router.push(`/chat/${data.session.id}`);
    } catch (error) {
      if (error instanceof Error) {
        setCreateSessionError(error.message);
        throw error;
      }
      const message = 'Failed to create remote session';
      setCreateSessionError(message);
      throw new Error(message);
    }
  }, [getCurrentSessionDefaults, remoteConnectionId, router, setWorkingDirectory, t]);

  const openFolderPicker = useCallback(async (defaultPath?: string) => {
    if (workspaceMode === 'remote') {
      setRemoteFolderPickerOpen(true);
      return;
    }
    if (isElectron) {
      const path = await openNativePicker({ defaultPath, title: t('folderPicker.title') });
      if (path) handleFolderSelect(path);
    } else {
      setFolderPickerOpen(true);
    }
  }, [workspaceMode, isElectron, openNativePicker, t, handleFolderSelect]);

  const handleNewChat = useCallback(async () => {
    setCreateSessionError(null);
    // Remote mode: create a session using last remote connection + path
    if (workspaceMode === 'remote') {
      const connId = remoteConnectionId
        || (typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-remote-connection-id') : null);
      const lastRemotePath = typeof window !== 'undefined'
        ? localStorage.getItem('codepilot:last-remote-path') : null;

      if (!connId || !lastRemotePath) {
        // No remote connection or path saved — navigate to new chat page to configure
        router.push('/chat');
        return;
      }

      setCreatingChat(true);
      try {
        const { model, provider_id, engine_type, reasoning_effort } = getCurrentSessionDefaults(
          buildEnginePreferenceTarget('remote', connId),
        );
        const res = await fetch("/api/chat/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_transport: 'ssh_direct',
            remote_connection_id: connId,
            remote_path: lastRemotePath,
            model,
            provider_id,
            engine_type,
            reasoning_effort,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          router.push(`/chat/${data.session.id}`);
          window.dispatchEvent(new CustomEvent("session-created"));
        } else {
          const data = await res.json().catch(() => ({ error: 'Failed to create session' }));
          setCreateSessionError(data.error || 'Failed to create session');
        }
      } catch {
        setCreateSessionError('Failed to create session');
      } finally {
        setCreatingChat(false);
      }
      return;
    }

    // Local mode
    const lastDir = workingDirectory
      || (typeof window !== 'undefined' ? localStorage.getItem("codepilot:last-working-directory") : null);

    if (!lastDir) {
      // No saved directory — let user pick one
      openFolderPicker();
      return;
    }

    // Validate the saved directory still exists
    setCreatingChat(true);
    try {
      const checkRes = await fetch(
        `/api/files/browse?dir=${encodeURIComponent(lastDir)}`
      );
      if (!checkRes.ok) {
        // Directory is gone — clear stale value and prompt user
        localStorage.removeItem("codepilot:last-working-directory");
        openFolderPicker();
        return;
      }

      const { model, provider_id, engine_type, reasoning_effort } = getCurrentSessionDefaults(
        buildEnginePreferenceTarget('local'),
      );
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working_directory: lastDir, model, provider_id, engine_type, reasoning_effort }),
      });
      if (!res.ok) {
        // Backend rejected it (e.g. INVALID_DIRECTORY) — prompt user
        localStorage.removeItem("codepilot:last-working-directory");
        openFolderPicker();
        return;
      }
      const data = await res.json();
      router.push(`/chat/${data.session.id}`);
      window.dispatchEvent(new CustomEvent("session-created"));
    } catch {
      openFolderPicker();
    } finally {
      setCreatingChat(false);
    }
  }, [router, workingDirectory, workspaceMode, remoteConnectionId, openFolderPicker, getCurrentSessionDefaults]);

  const toggleProject = useCallback((groupKey: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      saveCollapsedProjects(next);
      return next;
    });
  }, []);

  // AbortController ref for cancelling in-flight requests
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSessions = useCallback(async () => {
    // Cancel any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/chat/sessions", { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (e) {
      // Ignore abort errors; log others
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }, []);

  const debouncedFetchSessions = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchSessions();
    }, 300);
  }, [fetchSessions]);

  // Fetch on mount
  useEffect(() => {
    fetchSessions();
    return () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fetchSessions]);

  // Refresh session list when a session is created or updated (debounced)
  useEffect(() => {
    const handler = () => debouncedFetchSessions();
    window.addEventListener("session-created", handler);
    window.addEventListener("session-updated", handler);
    return () => {
      window.removeEventListener("session-created", handler);
      window.removeEventListener("session-updated", handler);
    };
  }, [debouncedFetchSessions]);

  const syncImportEngineType = useCallback(() => {
    const activeSession = sessions.find((session) => pathname === `/chat/${session.id}`);
    if (
      activeSession?.engine_type
      && (
        (workspaceMode === 'remote' && activeSession.workspace_transport === 'ssh_direct')
        || (workspaceMode === 'local' && activeSession.workspace_transport !== 'ssh_direct')
      )
    ) {
      setImportEngineType(normalizeEngineType(activeSession.engine_type));
      return;
    }

    setImportEngineType(readActiveEngine(buildEnginePreferenceTarget(workspaceMode, remoteConnectionId)));
  }, [pathname, remoteConnectionId, sessions, workspaceMode]);

  useEffect(() => {
    syncImportEngineType();
  }, [syncImportEngineType]);

  useEffect(() => {
    const handler = () => syncImportEngineType();
    window.addEventListener("engine-changed", handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("engine-changed", handler);
      window.removeEventListener("storage", handler);
    };
  }, [syncImportEngineType]);

  // Periodic poll to catch sessions created server-side (e.g. bridge)
  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      fetchSessions();
    }, 15000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const handleDeleteSession = (
    e: React.MouseEvent,
    session: ChatSession
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setPendingDeleteSession(session);
  };

  const confirmDeleteSession = useCallback(async (session: ChatSession | null) => {
    if (!session) return;
    const sessionId = session.id;
    setDeletingSession(sessionId);
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        // Remove from split if it's there
        if (isInSplit(sessionId)) {
          removeFromSplit(sessionId);
        }
        if (pathname === `/chat/${sessionId}`) {
          router.push("/chat");
        }
      }
    } catch {
      // Silently fail
    } finally {
      setDeletingSession(null);
      setPendingDeleteSession(null);
    }
  }, [isInSplit, removeFromSplit, pathname, router]);

  const isSessionRuntimeActive = useCallback((session: ChatSession) => {
    return session.runtime_status === 'running'
      || session.runtime_status === 'waiting_permission'
      || activeStreamingSessions.has(session.id)
      || streamingSessionId === session.id;
  }, [activeStreamingSessions, streamingSessionId]);

  const isSessionAwaitingApproval = useCallback((session: ChatSession) => {
    return session.runtime_status === 'waiting_permission'
      || pendingApprovalSessionIds.has(session.id)
      || pendingApprovalSessionId === session.id;
  }, [pendingApprovalSessionId, pendingApprovalSessionIds]);

  const handleCreateSessionInProject = async (
    e: React.MouseEvent,
    group: ProjectGroup
  ) => {
    e.stopPropagation();
    setCreateSessionError(null);
    try {
      const defaults = getCurrentSessionDefaults(
        group.workspaceTransport === 'ssh_direct'
          ? buildEnginePreferenceTarget('remote', group.remoteConnectionId || remoteConnectionId)
          : buildEnginePreferenceTarget('local')
      );
      const body: Record<string, string> = { model: defaults.model, provider_id: defaults.provider_id, engine_type: defaults.engine_type, reasoning_effort: defaults.reasoning_effort };

      if (group.workspaceTransport === 'ssh_direct') {
        // Remote project group — reuse the existing project context, but keep
        // runtime defaults sourced from the remote workspace selector.
        const existingSession = group.sessions[0];
        const sourceSession = group.sessions.find((session) =>
          session.workspace_transport === 'ssh_direct'
          && (session.remote_connection_id || '') === (group.remoteConnectionId || session.remote_connection_id || '')
          && Boolean((session.remote_path || session.working_directory || '').trim())
        ) || existingSession;
        const connId = sourceSession?.remote_connection_id
          || group.remoteConnectionId
          || existingSession?.remote_connection_id
          || remoteConnectionId
          || (typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-remote-connection-id') : '') || '';
        if (!connId) {
          setCreateSessionError(t('chat.remoteConnectionRequired'));
          return;
        }
        const projectRemotePath = (sourceSession?.remote_path || sourceSession?.working_directory || group.remotePath || group.workingDirectory || '').trim();
        if (!projectRemotePath) {
          setCreateSessionError('Remote project path is missing for this directory');
          return;
        }
        body.workspace_transport = 'ssh_direct';
        body.remote_connection_id = connId;
        body.remote_path = projectRemotePath;
        if (sourceSession?.id) {
          body.source_session_id = sourceSession.id;
        }
      } else {
        body.working_directory = group.workingDirectory;
      }

      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        window.dispatchEvent(new CustomEvent("session-created"));
        router.push(`/chat/${data.session.id}`);
      } else {
        const data = await res.json().catch(() => ({ error: 'Failed to create session' }));
        setCreateSessionError(data.error || 'Failed to create session');
      }
    } catch {
      setCreateSessionError('Failed to create session');
    }
  };

  const handleRemoveProject = useCallback((e: React.MouseEvent, group: ProjectGroup) => {
    e.preventDefault();
    e.stopPropagation();
    setPendingDeleteProject(group);
  }, []);

  const pauseProject = useCallback((e: React.MouseEvent, group: ProjectGroup) => {
    e.preventDefault();
    e.stopPropagation();
    setPausedProjects((prev) => {
      const next = new Set(prev);
      next.add(group.groupKey);
      savePausedProjects(next);
      return next;
    });
  }, []);

  const restoreProject = useCallback((e: React.MouseEvent, group: ProjectGroup) => {
    e.preventDefault();
    e.stopPropagation();
    setPausedProjects((prev) => {
      const next = new Set(prev);
      next.delete(group.groupKey);
      savePausedProjects(next);
      return next;
    });
  }, []);

  const confirmRemoveProject = useCallback((group: ProjectGroup | null) => {
    if (!group) return;
    setPausedProjects((prev) => {
      const next = new Set(prev);
      next.delete(group.groupKey);
      savePausedProjects(next);
      return next;
    });
    setHiddenProjects((prev) => {
      const next = new Set(prev);
      next.add(group.groupKey);
      saveHiddenProjects(next);
      return next;
    });
    setHoveredFolder((current) => (current === group.groupKey ? null : current));
    setPendingDeleteProject(null);
  }, []);

  const isSearching = searchQuery.length > 0;

  const splitSessionIds = useMemo(
    () => new Set(splitSessions.map((s) => s.sessionId)),
    [splitSessions]
  );

  const filteredSessions = useMemo(() => {
    let result = sessions;
    if (searchQuery) {
      result = result.filter(
        (s) =>
          s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (s.project_name &&
            s.project_name.toLowerCase().includes(searchQuery.toLowerCase()))
      );
    }
    // Exclude sessions in split group (they are shown in the split section)
    if (isSplitActive) {
      result = result.filter((s) => !splitSessionIds.has(s.id));
    }
    return result;
  }, [sessions, searchQuery, isSplitActive, splitSessionIds]);

  const projectGroups = useMemo(
    () => groupSessionsByProject(filteredSessions),
    [filteredSessions]
  );

  const visibleProjectGroups = useMemo(
    () => projectGroups.filter((group) => !hiddenProjects.has(group.groupKey)),
    [projectGroups, hiddenProjects],
  );

  const activeProjectGroups = useMemo(
    () => visibleProjectGroups.filter((group) => !pausedProjects.has(group.groupKey)),
    [visibleProjectGroups, pausedProjects],
  );

  const stoppedProjectGroups = useMemo(
    () => visibleProjectGroups.filter((group) => pausedProjects.has(group.groupKey)),
    [visibleProjectGroups, pausedProjects],
  );

  const displayedProjectGroups = useMemo(
    () => projectListView === 'active' ? activeProjectGroups : stoppedProjectGroups,
    [projectListView, activeProjectGroups, stoppedProjectGroups],
  );

  useEffect(() => {
    setCollapsedProjects(loadCollapsedProjects());
    setPausedProjects(loadPausedProjects());
    setHiddenProjects(loadHiddenProjects());
  }, []);

  const syncMainAreaForWorkspaceMode = useCallback((mode: 'local' | 'remote') => {
    setWorkspaceMode(mode);
    setSessionId('');

    if (typeof window !== 'undefined') {
      const nextDirectory = mode === 'remote'
        ? (localStorage.getItem('codepilot:last-remote-path') || '')
        : (localStorage.getItem('codepilot:last-working-directory') || '');
      setWorkingDirectory(nextDirectory);
    } else {
      setWorkingDirectory('');
    }

    if (pathname.startsWith('/chat/')) {
      router.push('/chat');
    }
  }, [pathname, router, setSessionId, setWorkingDirectory, setWorkspaceMode]);

  // On first use, auto-collapse all project groups except the most recent one
  useEffect(() => {
    if (projectGroups.length <= 1) return;
    if (localStorage.getItem(COLLAPSED_INITIALIZED_KEY)) return;
    const toCollapse = new Set(
      projectGroups.slice(1).map((g) => g.groupKey)
    );
    setCollapsedProjects(toCollapse);
    saveCollapsedProjects(toCollapse);
    localStorage.setItem(COLLAPSED_INITIALIZED_KEY, "1");
  }, [projectGroups]);

  const renderProjectGroup = useCallback((group: ProjectGroup, section: 'active' | 'stopped') => {
    const isCollapsed = !isSearching && collapsedProjects.has(group.groupKey);
    const isFolderHovered = hoveredFolder === group.groupKey;
    const runningSessions = group.sessions.filter(isSessionRuntimeActive).length;
    const waitingSessions = group.sessions.filter(isSessionAwaitingApproval).length;
    const statusBadge = waitingSessions > 0
      ? t('chatList.waitingSessionsBadge', { n: waitingSessions })
      : runningSessions > 0
        ? t('chatList.activeSessionsBadge', { n: runningSessions })
        : null;

    return (
      <div key={group.groupKey || "__no_project"} className="mt-1 first:mt-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 cursor-pointer select-none transition-colors",
                "hover:bg-accent/50",
                section === 'stopped' && "opacity-80"
              )}
              onClick={() => toggleProject(group.groupKey)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (group.workingDirectory) {
                  if (window.electronAPI?.shell?.openPath) {
                    window.electronAPI.shell.openPath(group.workingDirectory);
                  } else {
                    fetch('/api/files/open', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ session_id: group.openSessionId }),
                    }).catch(() => {});
                  }
                }
              }}
              onMouseEnter={() => setHoveredFolder(group.groupKey)}
              onMouseLeave={() => setHoveredFolder(null)}
            >
              <HugeiconsIcon
                icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
              <HugeiconsIcon
                icon={isCollapsed ? Folder01Icon : FolderOpenIcon}
                className={cn("h-4 w-4 shrink-0", group.workspaceTransport === 'ssh_direct' ? "text-blue-500" : "text-muted-foreground")}
              />
              <span className="flex-1 truncate text-[13px] font-medium text-sidebar-foreground">
                {group.displayName}
              </span>
              {statusBadge && (
                <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  {statusBadge}
                </span>
              )}
              {group.workspaceTransport === 'ssh_direct' && (
                <span className="shrink-0 rounded-sm bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                  SSH
                </span>
              )}
              {group.workingDirectory !== "" && (
                <div className="flex items-center gap-0.5 shrink-0">
                  {section === 'active' ? (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className={cn(
                              "h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground transition-opacity",
                              isFolderHovered ? "opacity-100" : "opacity-0"
                            )}
                            tabIndex={isFolderHovered ? 0 : -1}
                            onClick={(e) => handleCreateSessionInProject(e, group)}
                          >
                            <HugeiconsIcon
                              icon={PlusSignIcon}
                              className="h-3.5 w-3.5"
                            />
                            <span className="sr-only">
                              {t('chatList.newChatInProject', { title: group.displayName })}
                            </span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {t('chatList.newChatInProject', { title: group.displayName })}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className={cn(
                              "h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground transition-opacity",
                              isFolderHovered ? "opacity-100" : "opacity-0"
                            )}
                            tabIndex={isFolderHovered ? 0 : -1}
                            onClick={(e) => pauseProject(e, group)}
                          >
                            <Pause className="h-3.5 w-3.5" />
                            <span className="sr-only">
                              {t('chatList.pauseProject')}
                            </span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {t('chatList.pauseProject')}
                        </TooltipContent>
                      </Tooltip>
                    </>
                  ) : (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className={cn(
                              "h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground transition-opacity",
                              isFolderHovered ? "opacity-100" : "opacity-0"
                            )}
                            tabIndex={isFolderHovered ? 0 : -1}
                            onClick={(e) => restoreProject(e, group)}
                          >
                            <Play className="h-3.5 w-3.5" />
                            <span className="sr-only">
                              {t('chatList.restoreProject')}
                            </span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {t('chatList.restoreProject')}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className={cn(
                              "h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive transition-opacity",
                              isFolderHovered ? "opacity-100" : "opacity-0"
                            )}
                            tabIndex={isFolderHovered ? 0 : -1}
                            onClick={(e) => handleRemoveProject(e, group)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="sr-only">
                              {t('chatList.permanentDeleteProject')}
                            </span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {t('chatList.permanentDeleteProject')}
                        </TooltipContent>
                      </Tooltip>
                    </>
                  )}
                </div>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs">
            {group.workspaceTransport === 'ssh_direct' ? (
              <p className="text-xs break-all">{t('chat.remotePath')}: {group.remotePath || group.displayName}</p>
            ) : (
              <>
                <p className="text-xs break-all">{group.workingDirectory || 'No Project'}</p>
                {group.workingDirectory && <p className="text-[10px] text-muted-foreground mt-0.5">{t('chat.openProjectHint')}</p>}
              </>
            )}
          </TooltipContent>
        </Tooltip>

        {!isCollapsed && (
          <div className="mt-0.5 flex flex-col gap-0.5">
            {group.sessions.map((session) => {
              const isActive = pathname === `/chat/${session.id}`;
              const isHovered = hoveredSession === session.id;
              const isDeleting = deletingSession === session.id;
              const isSessionStreaming = isSessionRuntimeActive(session);
              const needsApproval = isSessionAwaitingApproval(session);
              const canSplit = !isActive && !isInSplit(session.id);

              return (
                <div
                  key={session.id}
                  className="group relative"
                  onMouseEnter={() => setHoveredSession(session.id)}
                  onMouseLeave={() => setHoveredSession(null)}
                >
                  <Link
                    href={`/chat/${session.id}`}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2 py-1.5 transition-all duration-150 min-w-0",
                      isActive
                        ? "border-sidebar-accent bg-sidebar-accent text-sidebar-accent-foreground"
                        : isSessionStreaming
                          ? "border-emerald-500/20 bg-emerald-500/5 text-sidebar-foreground hover:bg-emerald-500/10"
                          : "border-transparent text-sidebar-foreground hover:bg-accent/50"
                    )}
                  >
                    <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      {canSplit && (
                        <button
                          className={cn(
                            "absolute inset-0 flex items-center justify-center text-muted-foreground hover:text-foreground transition-opacity",
                            isHovered ? "opacity-100" : "opacity-0 pointer-events-none"
                          )}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            addToSplit({
                              sessionId: session.id,
                              title: session.title,
                              workingDirectory: session.working_directory || "",
                              projectName: session.project_name || "",
                              mode: session.mode,
                            });
                          }}
                        >
                          <Columns2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {isSessionStreaming && (
                        <span className={cn(
                          "relative flex h-2 w-2 transition-opacity",
                          isHovered && canSplit ? "opacity-0" : "opacity-100"
                        )}>
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                          <span className={cn(
                            "relative inline-flex h-2 w-2 rounded-full",
                            needsApproval ? "bg-amber-500" : "bg-green-500"
                          )} />
                        </span>
                      )}
                      {needsApproval && !isSessionStreaming && (
                        <span className={cn(
                          "flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500/10 transition-opacity",
                          isHovered && canSplit ? "opacity-0" : "opacity-100"
                        )}>
                          <HugeiconsIcon icon={Notification02Icon} className="h-2.5 w-2.5 text-amber-500" />
                        </span>
                      )}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="line-clamp-1 text-[13px] font-medium leading-tight break-all">
                        {session.title}
                      </span>
                    </div>
                    <div className="relative h-5 w-[78px] shrink-0">
                      {isSessionStreaming ? (
                        <span className={cn(
                          "absolute inset-0 flex items-center justify-end transition-opacity",
                          (isHovered || isDeleting) ? "opacity-0" : "opacity-100"
                        )}>
                          <span className={cn(
                            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                            needsApproval
                              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                              : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          )}>
                            {needsApproval ? t('chatList.waitingSession') : t('chatList.activeSession')}
                          </span>
                        </span>
                      ) : (
                        <span className={cn(
                          "absolute inset-0 flex items-center justify-end text-[11px] text-muted-foreground/40 truncate transition-opacity",
                          (isHovered || isDeleting) ? "opacity-0" : "opacity-100"
                        )}>
                          {formatRelativeTime(session.updated_at, t)}
                        </span>
                      )}
                      <button
                        className={cn(
                          "absolute inset-0 flex items-center justify-end text-muted-foreground/60 hover:text-destructive transition-opacity",
                          (isHovered || isDeleting) ? "opacity-100" : "opacity-0 pointer-events-none"
                        )}
                        onClick={(e) => handleDeleteSession(e, session)}
                        disabled={isDeleting}
                      >
                        <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }, [
    addToSplit,
    collapsedProjects,
    deletingSession,
    handleCreateSessionInProject,
    handleDeleteSession,
    handleRemoveProject,
    hoveredFolder,
    hoveredSession,
    isInSplit,
    isSearching,
    isSessionAwaitingApproval,
    isSessionRuntimeActive,
    pathname,
    pauseProject,
    restoreProject,
    t,
    toggleProject,
  ]);

  if (!open) return null;

  return (
    <>
    <aside
      className="fixed inset-y-0 left-14 z-50 flex h-full shrink-0 flex-col overflow-hidden bg-sidebar pb-3 shadow-xl lg:relative lg:inset-y-auto lg:left-auto lg:z-auto lg:shadow-none"
      style={{ width: width ?? 240 }}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <ConnectionStatus />
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => syncMainAreaForWorkspaceMode('local')}
            className={`rounded-md border px-2 py-0.5 text-[11px] leading-tight ${workspaceMode === 'local' ? 'border-foreground bg-accent text-foreground' : 'border-border text-muted-foreground'}`}
          >
            {t('chat.workspaceLocal')}
          </button>
          <button
            type="button"
            disabled={verifyingRemote}
            onClick={async () => {
              if (workspaceMode === 'remote') return;
              const cid = remoteConnectionId
                || (typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-remote-connection-id') : null);
              if (!cid) {
                setRemoteConnectionState('idle');
                syncMainAreaForWorkspaceMode('remote');
                return;
              }
              setVerifyingRemote(true);
              setRemoteConnectionReady(false);
              setRemoteConnectionState('checking');
              try {
                const res = await fetch(`/api/remote/connections/${cid}/health`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'check' }),
                });
                if (res.ok) {
                  const data = await res.json();
                  if (data?.health?.healthy) {
                    setRemoteConnectionReady(true);
                    setRemoteConnectionState('ready');
                  } else {
                    setRemoteConnectionReady(false);
                    setRemoteConnectionState('disconnected');
                  }
                } else {
                  setRemoteConnectionReady(false);
                  setRemoteConnectionState('error');
                }
              } catch {
                setRemoteConnectionReady(false);
                setRemoteConnectionState('error');
              } finally {
                setVerifyingRemote(false);
                syncMainAreaForWorkspaceMode('remote');
              }
            }}
            className={`rounded-md border px-2 py-0.5 text-[11px] leading-tight ${workspaceMode === 'remote' ? 'border-foreground bg-accent text-foreground' : 'border-border text-muted-foreground'} ${verifyingRemote ? 'opacity-60' : ''}`}
          >
            {verifyingRemote ? t('chat.workspaceRemote') + '...' : t('chat.workspaceRemote')}
          </button>
        </div>
      </div>

      {/* New Chat + New Project */}
      <div className="flex items-center gap-2 px-3 pb-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 justify-center gap-1.5 h-8 text-xs"
          disabled={creatingChat}
          onClick={handleNewChat}
        >
          <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
          {t('chatList.newConversation')}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              className="h-8 w-8 shrink-0"
              onClick={() => openFolderPicker()}
            >
              <HugeiconsIcon icon={FolderOpenIcon} className="h-3.5 w-3.5" />
              <span className="sr-only">{t('chatList.addProjectFolder')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('chatList.addProjectFolder')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder={t('chatList.searchSessions')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Import CLI Session */}
      <div className="px-3 pb-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 h-7 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setImportDialogOpen(true)}
        >
          <HugeiconsIcon icon={FileImportIcon} className="h-3 w-3" />
          {t("chatList.importFromCli", {
            provider: importEngineType === "codex"
              ? t("chatList.providerCodex")
              : importEngineType === "gemini"
                ? t("chatList.providerGemini")
                : t("chatList.providerClaude"),
          })}
        </Button>
      </div>

      {/* Session creation error */}
      {createSessionError && (
        <div className="mx-3 mb-1 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
          <span className="flex-1 break-words">{createSessionError}</span>
          <button
            type="button"
            className="shrink-0 text-destructive/60 hover:text-destructive"
            onClick={() => setCreateSessionError(null)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Session list grouped by project */}
      <ScrollArea className="flex-1 min-h-0 px-3">
        <div className="flex flex-col pb-3">
          {/* Section title */}
          <div className="flex items-center gap-2 px-2 pt-1 pb-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              {t('chatList.threads')}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => setProjectListView('active')}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                  projectListView === 'active'
                    ? "border-foreground bg-accent text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {t('chatList.activeCount', { n: activeProjectGroups.length })}
              </button>
              <button
                type="button"
                onClick={() => setProjectListView('stopped')}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                  projectListView === 'stopped'
                    ? "border-foreground bg-accent text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {t('chatList.stoppedCount', { n: stoppedProjectGroups.length })}
              </button>
            </div>
          </div>

          {/* Split group section */}
          {isSplitActive && (
            <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 p-1.5">
              <div className="flex items-center gap-1.5 px-2 py-1">
                <Columns2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">{t('split.splitGroup')}</span>
              </div>
              <div className="mt-0.5 flex flex-col gap-0.5">
                {splitSessions.map((session) => {
                  const isActiveInSplit = activeColumnId === session.sessionId;
                  const isSessionStreaming =
                    activeStreamingSessions.has(session.sessionId) || streamingSessionId === session.sessionId;
                  const needsApproval =
                    pendingApprovalSessionIds.has(session.sessionId) || pendingApprovalSessionId === session.sessionId;

                  return (
                    <div
                      key={session.sessionId}
                      className={cn(
                        "group relative flex items-center gap-1.5 rounded-md pl-7 pr-2 py-1.5 transition-all duration-150 min-w-0 cursor-pointer",
                        isActiveInSplit
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground hover:bg-accent/50"
                      )}
                      onClick={(e) => {
                        e.preventDefault();
                        setActiveColumn(session.sessionId);
                      }}
                    >
                      {isSessionStreaming && (
                        <span className="relative flex h-2 w-2 shrink-0">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                        </span>
                      )}
                      {needsApproval && (
                        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
                          <HugeiconsIcon icon={Notification02Icon} className="h-2.5 w-2.5 text-amber-500" />
                        </span>
                      )}
                      <div className="flex-1 min-w-0">
                        <span className="line-clamp-1 text-[13px] font-medium leading-tight break-all">
                          {session.title}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="h-4 w-4 shrink-0 text-muted-foreground/60 hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFromSplit(session.sessionId);
                        }}
                      >
                        <X className="h-2.5 w-2.5" />
                        <span className="sr-only">{t('split.closeSplit')}</span>
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {visibleProjectGroups.length === 0 && (!isSplitActive || splitSessions.length === 0) ? (
            <p className="px-2.5 py-3 text-[11px] text-muted-foreground/60">
              {searchQuery ? "No matching threads" : t('chatList.noSessions')}
            </p>
          ) : displayedProjectGroups.length === 0 ? (
            <p className="px-2.5 py-2 text-[11px] text-muted-foreground/50">
              {projectListView === 'active' ? t('chatList.noActiveProjects') : t('chatList.noStoppedProjects')}
            </p>
          ) : (
            displayedProjectGroups.map((group) => renderProjectGroup(group, projectListView))
          )}
        </div>
      </ScrollArea>

      {/* Version */}
      <div className="shrink-0 px-3 py-2 text-center">
        <span className="text-[10px] text-muted-foreground/40">
          v{process.env.NEXT_PUBLIC_APP_VERSION}
        </span>
      </div>

      {/* Import CLI Session Dialog */}
      <ImportSessionDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        engineType={importEngineType}
        workspaceMode={workspaceMode}
        connectionId={remoteConnectionId || undefined}
      />

      <AlertDialog
        open={!!pendingDeleteSession}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteSession(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chatList.deleteDialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('chatList.deleteDialogDesc', {
                title: pendingDeleteSession?.title || t('chatList.newConversation'),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingSession}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!!deletingSession}
              onClick={() => {
                void confirmDeleteSession(pendingDeleteSession);
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!pendingDeleteProject}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteProject(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chatList.permanentDeleteProjectDialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('chatList.permanentDeleteProjectDialogDesc', {
                title: pendingDeleteProject?.displayName || t('chatList.addProjectFolder'),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                confirmRemoveProject(pendingDeleteProject);
              }}
            >
              {t('chatList.permanentDeleteProject')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Folder Picker Dialog */}
      <FolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={handleFolderSelect}
      />

      {/* Remote Folder Picker Dialog */}
      <RemoteFolderPicker
        open={remoteFolderPickerOpen}
        onOpenChange={setRemoteFolderPickerOpen}
        onSelect={handleRemoteFolderSelect}
        connectionId={remoteConnectionId}
        initialPath={typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-remote-path') || undefined : undefined}
      />
    </aside>
    </>
  );
}
