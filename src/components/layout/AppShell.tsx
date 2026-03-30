"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NavRail } from "./NavRail";
import { ChatListPanel } from "./ChatListPanel";
import { RightPanel } from "./RightPanel";
import { ResizeHandle } from "./ResizeHandle";
import { UpdateDialog } from "./UpdateDialog";
import { UpdateBanner } from "./UpdateBanner";
import { DocPreview } from "./DocPreview";
import {
  PanelContext,
  type PanelContent,
  type PreviewViewMode,
  type RemoteConnectionState,
} from "@/hooks/usePanel";
import { UpdateContext, type UpdateInfo } from "@/hooks/useUpdate";
import { ImageGenContext, useImageGenState } from "@/hooks/useImageGen";
import { BatchImageGenContext, useBatchImageGenState } from "@/hooks/useBatchImageGen";
import { SplitContext, type SplitSession } from "@/hooks/useSplit";
import { SplitChatContainer } from "./SplitChatContainer";
import { ErrorBoundary } from "./ErrorBoundary";
import { getActiveSessionIds, getSnapshot } from "@/lib/stream-session-manager";

const SPLIT_SESSIONS_KEY = "codepilot:split-sessions";
const SPLIT_ACTIVE_COLUMN_KEY = "codepilot:split-active-column";

function loadSplitSessions(): SplitSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SPLIT_SESSIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return [];
}

function saveSplitSessions(sessions: SplitSession[]) {
  if (sessions.length >= 2) {
    localStorage.setItem(SPLIT_SESSIONS_KEY, JSON.stringify(sessions));
  } else {
    localStorage.removeItem(SPLIT_SESSIONS_KEY);
    localStorage.removeItem(SPLIT_ACTIVE_COLUMN_KEY);
  }
}

function loadActiveColumn(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(SPLIT_ACTIVE_COLUMN_KEY) || "";
}

const EMPTY_SET = new Set<string>();
const CHATLIST_MIN = 180;
const CHATLIST_MAX = 400;
const RIGHTPANEL_MIN = 200;
const RIGHTPANEL_MAX = 480;
const DOCPREVIEW_MIN = 320;
const DOCPREVIEW_MAX = 800;

/** Extensions that default to "rendered" view mode */
const RENDERED_EXTENSIONS = new Set([".md", ".mdx", ".html", ".htm"]);

function defaultViewMode(filePath: string): PreviewViewMode {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  return RENDERED_EXTENSIONS.has(ext) ? "rendered" : "source";
}

const LG_BREAKPOINT = 1024;
const DISMISSED_VERSION_KEY = "codepilot_dismissed_update_version";
const UPDATE_SNOOZED_UNTIL_KEY = "codepilot_update_snoozed_until";
const REMOTE_CONNECTION_STORAGE_KEY = "codepilot:last-remote-connection-id";
const REMOTE_HEALTH_POLL_INTERVAL_MS = 5000;

type UpdateCheckFrequency = 'daily' | 'weekly' | 'monthly' | 'never';

const CHECK_INTERVALS: Record<UpdateCheckFrequency, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  never: 0,
};

/**
 * Read update settings from localStorage cache.
 * The cache is populated by:
 * - AppShell on mount (fetches from DB API and syncs to localStorage)
 * - GeneralSection when user changes settings (writes to DB + localStorage)
 */
function getCachedCheckFrequency(): UpdateCheckFrequency {
  if (typeof window === 'undefined') return 'daily';
  const v = localStorage.getItem('codepilot:update_check_frequency');
  if (v === 'daily' || v === 'weekly' || v === 'monthly' || v === 'never') return v;
  return 'daily';
}

function getCachedDialogEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem('codepilot:update_dialog_enabled') !== 'false';
}

function isSnoozedToday(): boolean {
  if (typeof window === 'undefined') return false;
  const until = localStorage.getItem(UPDATE_SNOOZED_UNTIL_KEY);
  if (!until) return false;
  return Date.now() < parseInt(until, 10);
}

function isDialogSuppressed(): boolean {
  if (!getCachedDialogEnabled()) return true;
  if (isSnoozedToday()) return true;
  return false;
}

function loadRemoteConnectionId(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(REMOTE_CONNECTION_STORAGE_KEY) || "";
}

function applyRemoteHealthState(
  status: string | null | undefined,
): { ready: boolean; state: RemoteConnectionState } {
  switch (status) {
    case 'connected':
      return { ready: true, state: 'ready' };
    case 'checking':
    case 'connecting':
      return { ready: false, state: 'checking' };
    case 'reconnecting':
      return { ready: false, state: 'reconnecting' };
    case 'disconnected':
      return { ready: false, state: 'disconnected' };
    default:
      return { ready: false, state: 'error' };
  }
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLoginRoute = pathname === "/login";

  const [chatListOpen, setChatListOpenRaw] = useState(false);

  // Panel width state with localStorage persistence
  const [chatListWidth, setChatListWidth] = useState(() => {
    if (typeof window === "undefined") return 240;
    return parseInt(localStorage.getItem("codepilot_chatlist_width") || "240");
  });
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    if (typeof window === "undefined") return 288;
    return parseInt(localStorage.getItem("codepilot_rightpanel_width") || "288");
  });

  const handleChatListResize = useCallback((delta: number) => {
    setChatListWidth((w) => Math.min(CHATLIST_MAX, Math.max(CHATLIST_MIN, w + delta)));
  }, []);
  const handleChatListResizeEnd = useCallback(() => {
    setChatListWidth((w) => {
      localStorage.setItem("codepilot_chatlist_width", String(w));
      return w;
    });
  }, []);

  const handleRightPanelResize = useCallback((delta: number) => {
    setRightPanelWidth((w) => Math.min(RIGHTPANEL_MAX, Math.max(RIGHTPANEL_MIN, w - delta)));
  }, []);
  const handleRightPanelResizeEnd = useCallback(() => {
    setRightPanelWidth((w) => {
      localStorage.setItem("codepilot_rightpanel_width", String(w));
      return w;
    });
  }, []);

  // Panel state
  const isChatRoute = pathname.startsWith("/chat/") || pathname === "/chat";

  // Auto-close chat list when leaving chat routes
  const setChatListOpen = useCallback((open: boolean) => {
    setChatListOpenRaw(open);
  }, []);

  useEffect(() => {
    if (!isChatRoute) {
      setChatListOpenRaw(false);
    }
  }, [isChatRoute]);
  const [panelOpen, setPanelOpenRaw] = useState(false);
  const [panelContent, setPanelContent] = useState<PanelContent>("files");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [streamingSessionId, setStreamingSessionId] = useState("");
  const [pendingApprovalSessionId, setPendingApprovalSessionId] = useState("");
  const [workspaceMode, setWorkspaceModeRaw] = useState<"local" | "remote">('local');
  const [remoteConnectionId, setRemoteConnectionIdRaw] = useState("");
  const setWorkspaceMode = useCallback((mode: "local" | "remote") => {
    setWorkspaceModeRaw(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('codepilot:last-workspace-mode', mode);
    }
  }, []);
  const setRemoteConnectionId = useCallback((id: string) => {
    setRemoteConnectionIdRaw(id);
    if (typeof window === "undefined") return;
    if (id) {
      localStorage.setItem(REMOTE_CONNECTION_STORAGE_KEY, id);
    } else {
      localStorage.removeItem(REMOTE_CONNECTION_STORAGE_KEY);
    }
    window.dispatchEvent(new Event("remote-connection-changed"));
  }, []);

  useEffect(() => {
    if (isLoginRoute) return;

    const storedWorkspaceMode = localStorage.getItem('codepilot:last-workspace-mode') === 'remote' ? 'remote' : 'local';
    setWorkspaceModeRaw(storedWorkspaceMode);

    const syncRemoteConnectionId = () => {
      setRemoteConnectionIdRaw(loadRemoteConnectionId());
    };

    syncRemoteConnectionId();
    window.addEventListener("remote-connection-changed", syncRemoteConnectionId);
    window.addEventListener("storage", syncRemoteConnectionId);
    return () => {
      window.removeEventListener("remote-connection-changed", syncRemoteConnectionId);
      window.removeEventListener("storage", syncRemoteConnectionId);
    };
  }, [isLoginRoute]);

  // --- Remote connection readiness state ---
  const [remoteConnectionReady, setRemoteConnectionReady] = useState(false);
  const [remoteConnectionState, setRemoteConnectionState] = useState<RemoteConnectionState>("idle");

  // --- Keep remote health monitoring alive until a manual disconnect ---
  const healthMonitorConnectionRef = useRef<string | null>(null);

  useEffect(() => {
    if (isLoginRoute) return;

    if (workspaceMode === 'remote') {
      if (remoteConnectionId && remoteConnectionId !== healthMonitorConnectionRef.current) {
        // Stop previous monitor if switching connections
        if (healthMonitorConnectionRef.current) {
          fetch(`/api/remote/connections/${healthMonitorConnectionRef.current}/health`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop' }),
          }).catch(() => {});
        }
        healthMonitorConnectionRef.current = remoteConnectionId;
        setRemoteConnectionReady(false);
        setRemoteConnectionState('checking');

        // Start health monitor
        fetch(`/api/remote/connections/${remoteConnectionId}/health`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start' }),
        }).catch(() => {});

        // Immediate connection verification
        fetch(`/api/remote/connections/${remoteConnectionId}/health`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'check' }),
        })
          .then((res) => res.ok ? res.json() : null)
          .then((data) => {
            const next = applyRemoteHealthState(data?.state?.status || data?.status || (data?.health?.healthy ? 'connected' : 'disconnected'));
            setRemoteConnectionReady(next.ready);
            setRemoteConnectionState(next.state);
          })
          .catch(() => {
            setRemoteConnectionReady(false);
            setRemoteConnectionState('error');
          });
      } else if (!remoteConnectionId) {
        setRemoteConnectionReady(false);
        setRemoteConnectionState('idle');
      }
    }
  }, [workspaceMode, remoteConnectionId, isLoginRoute]);

  useEffect(() => {
    if (isLoginRoute) return;
    if (!remoteConnectionId) return;
    if (healthMonitorConnectionRef.current !== remoteConnectionId) return;

    let cancelled = false;

    const syncRemoteHealth = async () => {
      try {
        const fetchHealthState = async () => {
          const res = await fetch(`/api/remote/connections/${remoteConnectionId}/health`, {
            cache: 'no-store',
          });
          if (!res.ok) {
            throw new Error('Failed to fetch remote connection health');
          }
          return res.json() as Promise<{
            monitoring_active?: boolean;
            status?: string;
            health?: { healthy?: boolean };
          }>;
        };

        let data = await fetchHealthState();
        if (!data.monitoring_active) {
          setRemoteConnectionReady(false);
          setRemoteConnectionState('checking');
          await fetch(`/api/remote/connections/${remoteConnectionId}/health`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start' }),
          });
          data = await fetchHealthState();
        }

        if (cancelled) return;

        const next = applyRemoteHealthState(
          data.status || (data.health?.healthy ? 'connected' : 'disconnected'),
        );
        setRemoteConnectionReady(next.ready);
        setRemoteConnectionState(next.state);
      } catch {
        if (cancelled) return;
        setRemoteConnectionReady(false);
        setRemoteConnectionState('error');
      }
    };

    void syncRemoteHealth();
    const interval = setInterval(() => {
      void syncRemoteHealth();
    }, REMOTE_HEALTH_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isLoginRoute, remoteConnectionId, setRemoteConnectionReady, setRemoteConnectionState]);

  // --- Multi-session stream tracking (driven by stream-session-manager) ---
  const [activeStreamingSessions, setActiveStreamingSessions] = useState<Set<string>>(EMPTY_SET);
  const [pendingApprovalSessionIds, setPendingApprovalSessionIds] = useState<Set<string>>(EMPTY_SET);

  // Listen for global stream events from stream-session-manager
  useEffect(() => {
    const handler = () => {
      const activeIds = getActiveSessionIds();
      setActiveStreamingSessions(activeIds.length > 0 ? new Set(activeIds) : EMPTY_SET);

      const approvals = new Set<string>();
      for (const sid of activeIds) {
        const snap = getSnapshot(sid);
        if (snap?.pendingPermission && !snap.permissionResolved) {
          approvals.add(sid);
        }
      }
      setPendingApprovalSessionIds(approvals.size > 0 ? approvals : EMPTY_SET);
    };
    // Sync immediately in case streams were already active before this effect subscribed.
    handler();
    window.addEventListener('stream-session-event', handler);
    return () => window.removeEventListener('stream-session-event', handler);
  }, []);

  // --- Split-screen state ---
  const [splitSessions, setSplitSessions] = useState<SplitSession[]>(() => loadSplitSessions());
  const [activeColumnId, setActiveColumnIdRaw] = useState<string>(() => loadActiveColumn());
  const isSplitActive = splitSessions.length >= 2;
  const isChatDetailRoute = pathname.startsWith("/chat/") || isSplitActive;
  const showGlobalDragStrip = !pathname.startsWith("/chat/") || isSplitActive;

  // Persist split sessions to localStorage
  useEffect(() => {
    saveSplitSessions(splitSessions);
    if (activeColumnId) {
      localStorage.setItem(SPLIT_ACTIVE_COLUMN_KEY, activeColumnId);
    }
  }, [splitSessions, activeColumnId]);

  // URL sync: when activeColumn changes, update router
  useEffect(() => {
    if (isSplitActive && activeColumnId) {
      const target = `/chat/${activeColumnId}`;
      if (pathname !== target) {
        router.replace(target);
      }
    }
  }, [isSplitActive, activeColumnId, pathname, router]);

  const setActiveColumn = useCallback((sessionId: string) => {
    setActiveColumnIdRaw(sessionId);
  }, []);

  const addToSplit = useCallback((session: SplitSession) => {
    setSplitSessions((prev) => {
      // If already in split, don't add again
      if (prev.some((s) => s.sessionId === session.sessionId)) return prev;

      if (prev.length < 2) {
        // First time entering split: add current active session + new session
        // The current session info comes from PanelContext
        const currentSessionId = sessionId;
        if (currentSessionId && currentSessionId !== session.sessionId) {
          const currentSession: SplitSession = {
            sessionId: currentSessionId,
            title: sessionTitle || "New Conversation",
            workingDirectory: workingDirectory || "",
            projectName: "",
            mode: "code",
          };
          // Check if current is already in the list
          const hasCurrentAlready = prev.some((s) => s.sessionId === currentSessionId);
          const next = hasCurrentAlready ? [...prev, session] : [...prev, currentSession, session];
          setActiveColumnIdRaw(session.sessionId);
          return next;
        }
      }

      // Append to existing split
      const next = [...prev, session];
      setActiveColumnIdRaw(session.sessionId);
      return next;
    });
  }, [sessionId, sessionTitle, workingDirectory]);

  const pendingNavigateRef = useRef<string | null>(null);

  const removeFromSplit = useCallback((removeId: string) => {
    setSplitSessions((prev) => {
      const next = prev.filter((s) => s.sessionId !== removeId);
      if (next.length <= 1) {
        // Exit split mode — defer navigation to useEffect
        if (next.length === 1) {
          pendingNavigateRef.current = next[0].sessionId;
        }
        return [];
      }
      // If removing active column, switch to first remaining
      setActiveColumnIdRaw((currentActive) =>
        currentActive === removeId ? next[0].sessionId : currentActive
      );
      return next;
    });
  }, []);

  // Deferred navigation after split exit (avoids setState-during-render)
  useEffect(() => {
    if (pendingNavigateRef.current) {
      const target = pendingNavigateRef.current;
      pendingNavigateRef.current = null;
      router.replace(`/chat/${target}`);
    }
  }, [splitSessions, router]);

  const exitSplit = useCallback(() => {
    const firstSession = splitSessions[0];
    setSplitSessions([]);
    setActiveColumnIdRaw("");
    if (firstSession) {
      router.replace(`/chat/${firstSession.sessionId}`);
    }
  }, [splitSessions, router]);

  const isInSplit = useCallback((sid: string) => {
    return splitSessions.some((s) => s.sessionId === sid);
  }, [splitSessions]);

  // Handle delete of a session that's in split
  useEffect(() => {
    const handler = () => {
      // Re-validate split sessions exist
      setSplitSessions((prev) => {
        // We don't remove here; deletion handler in ChatListPanel will call removeFromSplit
        return prev;
      });
    };
    window.addEventListener("session-deleted", handler);
    return () => window.removeEventListener("session-deleted", handler);
  }, []);

  // Exit split when navigating to non-chat routes
  useEffect(() => {
    if (isSplitActive && !pathname.startsWith("/chat")) {
      setSplitSessions([]);
      setActiveColumnIdRaw("");
    }
  }, [isSplitActive, pathname]);

  const splitContextValue = useMemo(
    () => ({
      splitSessions,
      activeColumnId,
      isSplitActive,
      addToSplit,
      removeFromSplit,
      setActiveColumn,
      exitSplit,
      isInSplit,
    }),
    [splitSessions, activeColumnId, isSplitActive, addToSplit, removeFromSplit, setActiveColumn, exitSplit, isInSplit]
  );

  // Warn before closing window/tab while any session is streaming
  useEffect(() => {
    if (activeStreamingSessions.size === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [activeStreamingSessions]);

  // --- Doc Preview state ---
  const [previewFile, setPreviewFileRaw] = useState<string | null>(null);
  const [previewViewMode, setPreviewViewMode] = useState<PreviewViewMode>("source");
  const [docPreviewWidth, setDocPreviewWidth] = useState(() => {
    if (typeof window === "undefined") return 480;
    return parseInt(localStorage.getItem("codepilot_docpreview_width") || "480");
  });

  const setPreviewFile = useCallback((path: string | null) => {
    setPreviewFileRaw(path);
    if (path) {
      setPreviewViewMode(defaultViewMode(path));
    }
  }, []);

  const handleDocPreviewResize = useCallback((delta: number) => {
    setDocPreviewWidth((w) => Math.min(DOCPREVIEW_MAX, Math.max(DOCPREVIEW_MIN, w - delta)));
  }, []);
  const handleDocPreviewResizeEnd = useCallback(() => {
    setDocPreviewWidth((w) => {
      localStorage.setItem("codepilot_docpreview_width", String(w));
      return w;
    });
  }, []);

  // Auto-open panel on chat detail routes, close on others
  // Also close doc preview when navigating away or switching sessions
  useEffect(() => {
    setPanelOpenRaw(isChatDetailRoute);
    setPreviewFileRaw(null);
  }, [isChatDetailRoute, pathname]);

  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenRaw(open);
  }, []);

  // Keep chat list state in sync when resizing across the breakpoint (only on chat routes)
  useEffect(() => {
    if (!isChatRoute) return;
    const mql = window.matchMedia(`(min-width: ${LG_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent) => setChatListOpenRaw(e.matches);
    mql.addEventListener("change", handler);
    setChatListOpenRaw(mql.matches);
    return () => mql.removeEventListener("change", handler);
  }, [isChatRoute]);

  // On mobile, auto-close the chat list drawer when navigating to a chat
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < LG_BREAKPOINT) {
      setChatListOpenRaw(false);
    }
  }, [pathname]);

  // --- Skip-permissions indicator ---
  const [skipPermissionsActive, setSkipPermissionsActive] = useState(false);

  const fetchSkipPermissions = useCallback(async () => {
    if (isLoginRoute) {
      setSkipPermissionsActive(false);
      return;
    }

    try {
      const res = await fetch("/api/settings/app");
      if (res.ok) {
        const data = await res.json();
        const s = data.settings || {};
        setSkipPermissionsActive(s.dangerously_skip_permissions === "true");
        // Sync update settings from DB to localStorage cache
        if (s.update_check_frequency) {
          localStorage.setItem('codepilot:update_check_frequency', s.update_check_frequency);
        }
        if (s.update_dialog_enabled !== undefined) {
          localStorage.setItem('codepilot:update_dialog_enabled', s.update_dialog_enabled === 'false' ? 'false' : 'true');
        }
      }
    } catch {
      // ignore
    }
  }, [isLoginRoute]);

  // Re-fetch when window gains focus / becomes visible instead of polling every 5s
  useEffect(() => {
    if (isLoginRoute) return;
    fetchSkipPermissions();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchSkipPermissions();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", fetchSkipPermissions);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", fetchSkipPermissions);
    };
  }, [fetchSkipPermissions, isLoginRoute]);

  // --- Update check state ---
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [showDialog, setShowDialog] = useState(false);

  // Runtime detection: native updater available when running in Electron with updater bridge
  const isNativeUpdater = typeof window !== "undefined" && !!window.electronAPI?.updater;

  // --- Native updater status listener ---
  useEffect(() => {
    if (isLoginRoute || !isNativeUpdater) return;
    const cleanup = window.electronAPI!.updater!.onStatus((event) => {
      switch (event.status) {
        case 'available':
          setUpdateInfo((prev) => ({
            updateAvailable: true,
            latestVersion: event.info?.version ?? prev?.latestVersion ?? '',
            currentVersion: prev?.currentVersion ?? '',
            releaseName: event.info?.releaseName ?? prev?.releaseName ?? '',
            releaseNotes: typeof event.info?.releaseNotes === 'string' ? event.info.releaseNotes : prev?.releaseNotes ?? '',
            releaseUrl: prev?.releaseUrl ?? '',
            publishedAt: event.info?.releaseDate ?? prev?.publishedAt ?? '',
            downloadProgress: null,
            readyToInstall: false,
            isNativeUpdate: true,
            lastError: null,
          }));
          {
            const ver = event.info?.version;
            const dismissed = localStorage.getItem(DISMISSED_VERSION_KEY);
            if (ver && dismissed !== ver && !isDialogSuppressed()) {
              setShowDialog(true);
            }
          }
          break;
        case 'not-available':
          setUpdateInfo((prev) => prev ? { ...prev, updateAvailable: false, isNativeUpdate: true, lastError: null } : prev);
          break;
        case 'downloading':
          setUpdateInfo((prev) => prev ? {
            ...prev,
            downloadProgress: event.progress?.percent ?? prev.downloadProgress,
            isNativeUpdate: true,
            lastError: null,
          } : prev);
          break;
        case 'downloaded':
          setUpdateInfo((prev) => prev ? {
            ...prev,
            readyToInstall: true,
            downloadProgress: 100,
            isNativeUpdate: true,
            lastError: null,
          } : prev);
          break;
        case 'error':
          setUpdateInfo((prev) => prev ? {
            ...prev,
            lastError: event.error ?? 'Unknown error',
            isNativeUpdate: true,
          } : prev);
          break;
      }
      if (event.status === 'checking') {
        setChecking(true);
      } else {
        setChecking(false);
      }
    });
    return cleanup;
  }, [isNativeUpdater, isLoginRoute]);

  // --- Browser-mode update check (fallback for non-Electron) ---
  const checkForUpdatesBrowser = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/app/updates");
      if (!res.ok) return;
      const data = await res.json();
      const info: UpdateInfo = {
        ...data,
        downloadProgress: null,
        readyToInstall: false,
        isNativeUpdate: false,
        lastError: null,
      };
      setUpdateInfo(info);

      if (info.updateAvailable) {
        const dismissed = localStorage.getItem(DISMISSED_VERSION_KEY);
        if (dismissed !== info.latestVersion && !isDialogSuppressed()) {
          setShowDialog(true);
        }
      }
    } catch {
      // silently ignore network errors
    } finally {
      setChecking(false);
    }
  }, []);

  // --- Unified check: native first, browser fallback ---
  const checkForUpdates = useCallback(async () => {
    if (isNativeUpdater) {
      try {
        await window.electronAPI!.updater!.checkForUpdates();
        return;
      } catch {
        // native check failed, fall through to browser mode
      }
    }
    await checkForUpdatesBrowser();
  }, [isNativeUpdater, checkForUpdatesBrowser]);

  // Browser mode: periodic check based on frequency setting from DB (cached in localStorage)
  useEffect(() => {
    if (isLoginRoute || isNativeUpdater) return;
    const freq = getCachedCheckFrequency();
    if (freq === 'never') return;
    const interval = CHECK_INTERVALS[freq];
    checkForUpdatesBrowser();
    const id = setInterval(checkForUpdatesBrowser, interval);
    return () => clearInterval(id);
  }, [isNativeUpdater, checkForUpdatesBrowser, isLoginRoute]);

  const dismissUpdate = useCallback(() => {
    setShowDialog(false);
  }, []);

  const downloadUpdate = useCallback(async () => {
    if (isNativeUpdater) {
      await window.electronAPI!.updater!.downloadUpdate();
    }
  }, [isNativeUpdater]);

  const quitAndInstall = useCallback(() => {
    if (isNativeUpdater) {
      window.electronAPI!.updater!.quitAndInstall();
    }
  }, [isNativeUpdater]);

  const updateContextValue = useMemo(
    () => ({
      updateInfo,
      checking,
      checkForUpdates,
      downloadUpdate,
      dismissUpdate,
      showDialog,
      setShowDialog,
      quitAndInstall,
    }),
    [updateInfo, checking, checkForUpdates, downloadUpdate, dismissUpdate, showDialog, quitAndInstall]
  );

  const panelContextValue = useMemo(
    () => ({
      panelOpen,
      setPanelOpen,
      panelContent,
      setPanelContent,
      workingDirectory,
      setWorkingDirectory,
      sessionId,
      setSessionId,
      sessionTitle,
      setSessionTitle,
      streamingSessionId,
      setStreamingSessionId,
      pendingApprovalSessionId,
      setPendingApprovalSessionId,
      activeStreamingSessions,
      pendingApprovalSessionIds,
      previewFile,
      setPreviewFile,
      previewViewMode,
      setPreviewViewMode,
      workspaceMode,
      setWorkspaceMode,
      remoteConnectionId,
      setRemoteConnectionId,
      remoteConnectionReady,
      setRemoteConnectionReady,
      remoteConnectionState,
      setRemoteConnectionState,
      toggleChatList: () => setChatListOpen(!chatListOpen),
    }),
    [panelOpen, setPanelOpen, panelContent, workingDirectory, sessionId, sessionTitle, streamingSessionId, pendingApprovalSessionId, activeStreamingSessions, pendingApprovalSessionIds, previewFile, setPreviewFile, previewViewMode, workspaceMode, setWorkspaceMode, remoteConnectionId, setRemoteConnectionId, remoteConnectionReady, remoteConnectionState, chatListOpen, setChatListOpen]
  );

  const imageGenValue = useImageGenState();
  const batchImageGenValue = useBatchImageGenState();

  return (
    <UpdateContext.Provider value={updateContextValue}>
      <PanelContext.Provider value={panelContextValue}>
        <SplitContext.Provider value={splitContextValue}>
        <ImageGenContext.Provider value={imageGenValue}>
        <BatchImageGenContext.Provider value={batchImageGenValue}>
        <TooltipProvider delayDuration={300}>
          {isLoginRoute ? (
            <main className="h-full overflow-auto">
              <ErrorBoundary>{children}</ErrorBoundary>
            </main>
          ) : (
            <>
              <div className="flex h-full overflow-hidden">
                <NavRail
                  chatListOpen={chatListOpen}
                  onToggleChatList={() => setChatListOpen(!chatListOpen)}
                  hasUpdate={updateInfo?.updateAvailable ?? false}
                  readyToInstall={updateInfo?.readyToInstall ?? false}
                  skipPermissionsActive={skipPermissionsActive}
                />
                <ErrorBoundary>
                  <ChatListPanel open={chatListOpen} width={chatListWidth} onClose={() => setChatListOpen(false)} />
                </ErrorBoundary>
                {chatListOpen && (
                  <ResizeHandle side="left" onResize={handleChatListResize} onResizeEnd={handleChatListResizeEnd} />
                )}
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  {showGlobalDragStrip && (
                    <div
                      className="h-5 w-full shrink-0"
                      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
                    />
                  )}
                  <UpdateBanner />
                  <main className="relative flex-1 overflow-hidden">
                    {isSplitActive ? (
                      <SplitChatContainer />
                    ) : (
                      <ErrorBoundary>{children}</ErrorBoundary>
                    )}
                  </main>
                </div>
                {isChatDetailRoute && previewFile && (
                  <ResizeHandle side="right" onResize={handleDocPreviewResize} onResizeEnd={handleDocPreviewResizeEnd} />
                )}
                {isChatDetailRoute && previewFile && (
                  <ErrorBoundary>
                    <DocPreview
                      filePath={previewFile}
                      viewMode={previewViewMode}
                      onViewModeChange={setPreviewViewMode}
                      onClose={() => setPreviewFile(null)}
                      width={docPreviewWidth}
                    />
                  </ErrorBoundary>
                )}
                {isChatDetailRoute && panelOpen && (
                  <ResizeHandle side="right" onResize={handleRightPanelResize} onResizeEnd={handleRightPanelResizeEnd} />
                )}
                {isChatDetailRoute && panelOpen && (
                  <ErrorBoundary>
                    <RightPanel width={rightPanelWidth} />
                  </ErrorBoundary>
                )}
              </div>
              <UpdateDialog />
            </>
          )}
        </TooltipProvider>
        </BatchImageGenContext.Provider>
        </ImageGenContext.Provider>
        </SplitContext.Provider>
      </PanelContext.Provider>
    </UpdateContext.Provider>
  );
}
