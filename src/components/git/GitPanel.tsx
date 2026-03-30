"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, FolderGit2, Github, Loader2, Sparkles } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useNativeFolderPicker } from "@/hooks/useNativeFolderPicker";
import { useTranslation } from "@/hooks/useTranslation";
import type { WorkspaceMode } from "@/hooks/usePanel";
import type {
  GitBranches,
  GitHubAuthSessionSummary,
  GitHubCloneProgressEvent,
  GitHubDeviceCode,
  GitHubDeviceCodeResponse,
  GitHubDevicePollResponse,
  GitBranchesResponse,
  GitCommitMessageResponse,
  GitCommitResponse,
  GitDiffResponse,
  GitFileStatus,
  GitLogEntry,
  GitLogResponse,
  GitRemote,
  GitRemotesResponse,
  GitRequestContext,
  GitStatus,
  GitStatusActionResponse,
  GitStatusResponse,
} from "@/types";
import { GitBranchSelector } from "./GitBranchSelector";
import { GitChanges } from "./GitChanges";
import { GitCommitForm } from "./GitCommitForm";
import { GitDiffView } from "./GitDiffView";
import { GitLogView } from "./GitLogView";
import { GitPushPullBar } from "./GitPushPullBar";
import { GitRemoteManager } from "./GitRemoteManager";
import { GitStatusBar } from "./GitStatusBar";

interface GitPanelProps {
  sessionId?: string;
  workingDirectory: string;
  workspaceMode: WorkspaceMode;
  remoteConnectionId: string;
}

type DiffSelection =
  | { kind: "commit"; sha: string; title: string }
  | { kind: "file"; file: string; staged: boolean; title: string }
  | null;

const EMPTY_BRANCHES: GitBranches = { current: "", local: [], remote: [] };

function buildGitContext(
  sessionId: string | undefined,
  workingDirectory: string,
  workspaceMode: WorkspaceMode,
  remoteConnectionId: string,
): GitRequestContext | null {
  if (sessionId) {
    return { session_id: sessionId };
  }
  if (!workingDirectory) {
    return null;
  }
  if (workspaceMode === "remote") {
    if (!remoteConnectionId) {
      return null;
    }
    return {
      transport: "ssh_direct",
      connection_id: remoteConnectionId,
      remote_path: workingDirectory,
      cwd: workingDirectory,
    };
  }
  return {
    transport: "local",
    cwd: workingDirectory,
  };
}

function contextToQuery(context: GitRequestContext): string {
  const params = new URLSearchParams();
  if (context.session_id) params.set("session_id", context.session_id);
  if (context.cwd) params.set("cwd", context.cwd);
  if (context.transport) params.set("transport", context.transport);
  if (context.connection_id) params.set("connection_id", context.connection_id);
  if (context.remote_path) params.set("remote_path", context.remote_path);
  return params.toString();
}

async function readJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = typeof data?.error === "string" ? data.error : `Request failed (${response.status})`;
    throw new Error(error);
  }
  return data as T;
}

async function readJsonResponse<T>(input: RequestInfo, init?: RequestInit): Promise<{ status: number; ok: boolean; data: T }> {
  const response = await fetch(input, init);
  const data = await response.json().catch(() => ({}));
  return {
    status: response.status,
    ok: response.ok,
    data: data as T,
  };
}

function deriveCloneDirectoryName(repositoryUrl: string): string {
  try {
    const parsed = new URL(repositoryUrl);
    const segment = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return segment.replace(/\.git$/i, "");
  } catch {
    return "";
  }
}

function suggestCloneDestination(baseDirectory: string, repositoryUrl: string): string {
  const nextBase = baseDirectory.trim();
  if (!nextBase) {
    return "";
  }
  const repoName = deriveCloneDirectoryName(repositoryUrl);
  if (!repoName) {
    return nextBase;
  }
  return `${nextBase.replace(/[\\/]+$/, "")}/${repoName}`;
}

export function GitPanel({
  sessionId,
  workingDirectory,
  workspaceMode,
  remoteConnectionId,
}: GitPanelProps) {
  const { t } = useTranslation();
  const { isElectron, openNativePicker } = useNativeFolderPicker();
  const context = useMemo(
    () => buildGitContext(sessionId, workingDirectory, workspaceMode, remoteConnectionId),
    [remoteConnectionId, sessionId, workingDirectory, workspaceMode],
  );

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranches>(EMPTY_BRANCHES);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [commitSummary, setCommitSummary] = useState("");
  const [diffSelection, setDiffSelection] = useState<DiffSelection>(null);
  const [diffTitle, setDiffTitle] = useState("");
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDestination, setCloneDestination] = useState("");
  const [githubAuth, setGithubAuth] = useState<GitHubAuthSessionSummary | null>(null);
  const [githubDeviceFlow, setGithubDeviceFlow] = useState<GitHubDeviceCode | null>(null);
  const [githubPolling, setGithubPolling] = useState(false);
  const [cloneProgress, setCloneProgress] = useState<GitHubCloneProgressEvent | null>(null);

  const refreshGitHubAuth = useCallback(async () => {
    if (typeof window === "undefined" || !window.electronAPI?.githubAuth?.getSession) {
      setGithubAuth({
        supported: false,
        configured: false,
        secure_storage_available: false,
        connected: false,
      });
      return;
    }

    const summary = await window.electronAPI.githubAuth.getSession();
    setGithubAuth(summary);
  }, []);

  const refreshAll = useCallback(async (silent: boolean = false) => {
    if (!context) return;

    setError("");
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const query = contextToQuery(context);
      const [statusData, branchesData, remotesData, logData] = await Promise.all([
        readJson<GitStatusResponse>("/api/git/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(context),
        }),
        readJson<GitBranchesResponse>(`/api/git/branches?${query}`),
        readJson<GitRemotesResponse>(`/api/git/remotes?${query}`),
        readJson<GitLogResponse>("/api/git/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...context, max_count: 50 }),
        }),
      ]);

      setStatus(statusData.status);
      setBranches(branchesData.is_repo ? branchesData.branches : EMPTY_BRANCHES);
      setRemotes(remotesData.is_repo ? remotesData.remotes : []);
      setEntries(logData.entries);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.refreshFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [context, t]);

  useEffect(() => {
    setStatus(null);
    setBranches(EMPTY_BRANCHES);
    setRemotes([]);
    setEntries([]);
    setDiff("");
    setDiffTitle("");
    setDiffSelection(null);
    void refreshAll(false);
  }, [refreshAll]);

  useEffect(() => {
    if (!context || pendingAction) return;
    const interval = window.setInterval(() => {
      void refreshAll(true);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [context, pendingAction, refreshAll]);

  useEffect(() => {
    void refreshGitHubAuth();
  }, [refreshGitHubAuth]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.githubAuth?.onCloneProgress) {
      return;
    }
    return window.electronAPI.githubAuth.onCloneProgress((event) => {
      setCloneProgress(event);
    });
  }, []);

  useEffect(() => {
    if (!githubDeviceFlow) {
      setGithubPolling(false);
      return;
    }
    if (typeof window === "undefined" || !window.electronAPI?.githubAuth?.storeSession) {
      setGithubPolling(false);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    const startedAt = Date.now();
    const baseInterval = Math.max(githubDeviceFlow.interval, 1) * 1000;

    const schedule = (delayMs: number) => {
      timer = window.setTimeout(() => {
        void pollOnce(delayMs);
      }, delayMs);
    };

    const pollOnce = async (delayMs: number) => {
      if (cancelled) return;
      if (Date.now() - startedAt >= githubDeviceFlow.expires_in * 1000) {
        setGithubDeviceFlow(null);
        setGithubPolling(false);
        setError(t("git.githubDeviceExpired"));
        return;
      }

      setGithubPolling(true);
      try {
        const response = await readJsonResponse<GitHubDevicePollResponse>("/api/github/device-poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: githubDeviceFlow.device_code }),
        });

        if (cancelled) return;

        const data = response.data;
        if (data.status === "approved" && data.session) {
          const githubBridge = window.electronAPI?.githubAuth;
          if (!githubBridge) {
            throw new Error(t("git.githubDesktopOnly"));
          }
          await githubBridge.storeSession(data.session);
          await refreshGitHubAuth();
          setGithubDeviceFlow(null);
          setGithubPolling(false);
          setNotice(
            data.session.user?.login
              ? `${t("git.githubConnected")}: @${data.session.user.login}`
              : t("git.githubConnected"),
          );
          return;
        }

        if (data.status === "pending" || data.status === "slow_down") {
          const nextInterval = Math.max(data.interval || githubDeviceFlow.interval, 1) * 1000;
          schedule(data.status === "slow_down" ? nextInterval + 5000 : nextInterval || delayMs || baseInterval);
          return;
        }

        setGithubDeviceFlow(null);
        setGithubPolling(false);
        setError(data.error || t("git.githubPollFailed"));
      } catch (nextError) {
        if (cancelled) return;
        setGithubDeviceFlow(null);
        setGithubPolling(false);
        setError(nextError instanceof Error ? nextError.message : t("git.githubPollFailed"));
      }
    };

    schedule(baseInterval);
    return () => {
      cancelled = true;
      setGithubPolling(false);
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [githubDeviceFlow, refreshGitHubAuth, t]);

  const loadDiff = useCallback(async (selection: DiffSelection) => {
    if (!context || !selection) return;

    setDiffSelection(selection);
    setDiffTitle(selection.title);
    setDiffLoading(true);
    setError("");

    try {
      const payload = selection.kind === "commit"
        ? { ...context, sha: selection.sha }
        : { ...context, file: selection.file, staged: selection.staged };
      const data = await readJson<GitDiffResponse>("/api/git/diff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setDiff(data.diff);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.diffLoadFailed"));
      setDiff("");
    } finally {
      setDiffLoading(false);
    }
  }, [context, t]);

  const runStatusMutation = useCallback(async (
    actionName: string,
    endpoint: string,
    payload: Record<string, unknown>,
    successMessage?: string,
  ) => {
    if (!context) return;
    setPendingAction(actionName);
    setError("");
    setNotice("");

    try {
      const data = await readJson<GitStatusActionResponse>(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...context, ...payload }),
      });
      if (data.error) {
        throw new Error(data.error);
      }
      await refreshAll(true);
      if (diffSelection) {
        await loadDiff(diffSelection);
      }
      if (successMessage) {
        setNotice(successMessage);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.actionFailed"));
    } finally {
      setPendingAction(null);
    }
  }, [context, diffSelection, loadDiff, refreshAll, t]);

  const handleStage = useCallback((file: GitFileStatus) => {
    void runStatusMutation(`stage:${file.path}`, "/api/git/stage", { files: [file.path] });
  }, [runStatusMutation]);

  const handleUnstage = useCallback((file: GitFileStatus) => {
    void runStatusMutation(`unstage:${file.path}`, "/api/git/unstage", { files: [file.path] });
  }, [runStatusMutation]);

  const handleStageAll = useCallback(() => {
    void runStatusMutation("stage-all", "/api/git/stage", { all: true });
  }, [runStatusMutation]);

  const handlePush = useCallback(() => {
    void runStatusMutation("push", "/api/git/push", {}, t("git.pushComplete"));
  }, [runStatusMutation, t]);

  const handlePull = useCallback(() => {
    void runStatusMutation("pull", "/api/git/pull", {}, t("git.pullComplete"));
  }, [runStatusMutation, t]);

  const handleFetch = useCallback(() => {
    void runStatusMutation("fetch", "/api/git/fetch", {}, t("git.fetchComplete"));
  }, [runStatusMutation, t]);

  const handleInitRepo = useCallback(() => {
    void runStatusMutation("init", "/api/git/init", {}, t("git.initComplete"));
  }, [runStatusMutation, t]);

  const handleCreateCommit = useCallback(async () => {
    if (!context || !commitMessage.trim()) return;
    setPendingAction("commit");
    setError("");
    setNotice("");

    try {
      const data = await readJson<GitCommitResponse>("/api/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...context, message: commitMessage.trim() }),
      });
      if (data.error) {
        throw new Error(data.error);
      }
      setCommitMessage("");
      setCommitSummary("");
      setNotice(data.commit?.summary ? `${t("git.commitCreated")}: ${data.commit.summary}` : t("git.commitCreated"));
      await refreshAll(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.commitFailed"));
    } finally {
      setPendingAction(null);
    }
  }, [commitMessage, context, refreshAll, t]);

  const handleGenerateCommit = useCallback(async () => {
    if (!context) return;
    setPendingAction("generate-commit");
    setError("");

    try {
      const data = await readJson<GitCommitMessageResponse>("/api/git/commit-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...context, staged: true }),
      });
      setCommitMessage(data.suggestion.message);
      setCommitSummary(data.suggestion.summary);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.commitSuggestionFailed"));
    } finally {
      setPendingAction(null);
    }
  }, [context, t]);

  const handleCheckoutBranch = useCallback(async (branch: string) => {
    if (!context || !branch) return;
    setPendingAction("checkout");
    setError("");

    try {
      await readJson<GitBranchesResponse>("/api/git/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...context, action: "checkout", branch }),
      });
      await refreshAll(true);
      setNotice(`${t("git.checkoutComplete")}: ${branch}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.branchActionFailed"));
    } finally {
      setPendingAction(null);
    }
  }, [context, refreshAll, t]);

  const handleCreateBranch = useCallback(async (name: string): Promise<boolean> => {
    if (!context || !name.trim()) return false;
    setPendingAction("create-branch");
    setError("");

    try {
      await readJson<GitBranchesResponse>("/api/git/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...context, action: "create", name: name.trim(), checkout: true }),
      });
      await refreshAll(true);
      setNotice(`${t("git.branchCreated")}: ${name.trim()}`);
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.branchActionFailed"));
      return false;
    } finally {
      setPendingAction(null);
    }
  }, [context, refreshAll, t]);

  const handleDeleteBranch = useCallback(async (branch: string) => {
    if (!context || !branch) return;
    if (!window.confirm(`${t("git.deleteBranch")} ${branch}?`)) {
      return;
    }
    setPendingAction("delete-branch");
    setError("");

    try {
      await readJson<GitBranchesResponse>("/api/git/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...context, action: "delete", name: branch }),
      });
      await refreshAll(true);
      setNotice(`${t("git.branchDeleted")}: ${branch}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.branchActionFailed"));
    } finally {
      setPendingAction(null);
    }
  }, [context, refreshAll, t]);

  const handleAddRemote = useCallback(async (name: string, url: string): Promise<boolean> => {
    if (!context) return false;
    setPendingAction("add-remote");
    setError("");

    try {
      await readJson<GitRemotesResponse>("/api/git/remotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...context, action: "add", name: name.trim(), url: url.trim() }),
      });
      await refreshAll(true);
      setNotice(`${t("git.remoteAdded")}: ${name.trim()}`);
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.remoteActionFailed"));
      return false;
    } finally {
      setPendingAction(null);
    }
  }, [context, refreshAll, t]);

  const handleRemoveRemote = useCallback(async (name: string) => {
    if (!context) return;
    if (!window.confirm(`${t("git.removeRemote")} ${name}?`)) {
      return;
    }
    setPendingAction(`remove-remote:${name}`);
    setError("");

    try {
      await readJson<GitRemotesResponse>("/api/git/remotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...context, action: "remove", name }),
      });
      await refreshAll(true);
      setNotice(`${t("git.remoteRemoved")}: ${name}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.remoteActionFailed"));
    } finally {
      setPendingAction(null);
    }
  }, [context, refreshAll, t]);

  const handleStartGitHubAuth = useCallback(async () => {
    if (workspaceMode !== "local") {
      setError(t("git.githubRemoteUnsupported"));
      return;
    }
    if (!isElectron || typeof window === "undefined" || !window.electronAPI?.githubAuth) {
      setError(t("git.githubDesktopOnly"));
      return;
    }
    if (!githubAuth?.configured) {
      setError(t("git.githubConfigMissing"));
      return;
    }
    if (!githubAuth.secure_storage_available) {
      setError(t("git.githubSecureStoreUnavailable"));
      return;
    }

    setPendingAction("github-auth");
    setError("");
    setNotice("");

    try {
      const data = await readJson<GitHubDeviceCodeResponse>("/api/github/device-code", {
        method: "POST",
      });
      if (!data.flow) {
        throw new Error(data.error || t("git.githubPollFailed"));
      }
      setGithubDeviceFlow(data.flow);
      setNotice(`${t("git.githubCodeLabel")}: ${data.flow.user_code}`);
      if (window.electronAPI.shell.openExternal) {
        await window.electronAPI.shell.openExternal(data.flow.verification_uri);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.githubPollFailed"));
    } finally {
      setPendingAction(null);
    }
  }, [githubAuth, isElectron, t, workspaceMode]);

  const handleDisconnectGitHub = useCallback(async () => {
    if (typeof window === "undefined" || !window.electronAPI?.githubAuth?.clearSession) {
      return;
    }
    setPendingAction("github-disconnect");
    setError("");
    try {
      const summary = await window.electronAPI.githubAuth.clearSession();
      setGithubAuth(summary);
      setGithubDeviceFlow(null);
      setNotice(t("git.githubSessionCleared"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.actionFailed"));
    } finally {
      setPendingAction(null);
    }
  }, [t]);

  const handlePickCloneDestination = useCallback(async () => {
    const selected = await openNativePicker({
      defaultPath: cloneDestination || workingDirectory || undefined,
      title: t("git.cloneBrowse"),
    });
    if (!selected) {
      return;
    }
    setCloneDestination(suggestCloneDestination(selected, cloneUrl) || selected);
  }, [cloneDestination, cloneUrl, openNativePicker, t, workingDirectory]);

  const handleClone = useCallback(async () => {
    if (!context || workspaceMode !== "local" || !cloneUrl.trim() || !cloneDestination.trim()) return;
    setPendingAction("clone");
    setError("");
    setNotice("");
    setCloneProgress(null);

    try {
      let resolvedDestination = cloneDestination.trim();

      if (isElectron && typeof window !== "undefined" && window.electronAPI?.githubAuth?.cloneRepository) {
        const result = await window.electronAPI.githubAuth.cloneRepository({
          repositoryUrl: cloneUrl.trim(),
          destination: resolvedDestination,
        });
        if (!result.success) {
          throw new Error(result.error || t("git.cloneFailed"));
        }
        resolvedDestination = result.destination || resolvedDestination;
      } else {
        const result = await readJson<{ destination?: string }>("/api/git/clone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...context,
            repository_url: cloneUrl.trim(),
            destination: resolvedDestination,
          }),
        });
        resolvedDestination = result.destination || resolvedDestination;
      }

      setNotice(`${t("git.cloneComplete")}: ${resolvedDestination}`);
      setCloneUrl("");
      setCloneDestination("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("git.cloneFailed"));
    } finally {
      setPendingAction(null);
    }
  }, [cloneDestination, cloneUrl, context, isElectron, t, workspaceMode]);

  const handlePreviewFile = useCallback((file: GitFileStatus, mode: "staged" | "unstaged") => {
    void loadDiff({
      kind: "file",
      file: file.path,
      staged: mode === "staged",
      title: `${t("git.diffTitle")}: ${file.path}`,
    });
  }, [loadDiff, t]);

  const handlePreviewCommit = useCallback((entry: GitLogEntry) => {
    void loadDiff({
      kind: "commit",
      sha: entry.sha,
      title: `${entry.short_sha} ${entry.message}`,
    });
  }, [loadDiff]);

  const selectedDiffKey = diffSelection?.kind === "file"
    ? `${diffSelection.staged ? "staged" : "unstaged"}:${diffSelection.file}`
    : null;

  const githubStatusMessage = workspaceMode === "remote"
    ? t("git.githubRemoteUnsupported")
    : !isElectron || !githubAuth?.supported
      ? t("git.githubDesktopOnly")
      : !githubAuth.configured
        ? t("git.githubConfigMissing")
        : !githubAuth.secure_storage_available
          ? t("git.githubSecureStoreUnavailable")
          : githubAuth.connected
            ? githubAuth.user?.login
              ? `${t("git.githubConnectedAs")}: @${githubAuth.user.login}`
              : t("git.githubConnected")
            : t("git.githubNotConnected");

  const cloneCard = (
    <Card className="gap-4">
      <CardHeader className="border-b">
        <CardTitle>{t("git.cloneTitle")}</CardTitle>
        <CardDescription>
          {workspaceMode === "local" ? t("git.cloneDescription") : t("git.cloneRemoteBlocked")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {workspaceMode === "local" ? (
          <>
            <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">{t("git.githubTitle")}</p>
                  <p className="text-xs text-muted-foreground">{t("git.githubDescription")}</p>
                </div>
                {githubAuth?.connected ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={handleDisconnectGitHub}
                    disabled={pendingAction === "github-disconnect"}
                  >
                    {pendingAction === "github-disconnect" ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t("git.githubDisconnect")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={handleStartGitHubAuth}
                    disabled={
                      pendingAction === "github-auth"
                      || githubPolling
                      || !isElectron
                      || !githubAuth?.configured
                      || !githubAuth.secure_storage_available
                    }
                  >
                    {pendingAction === "github-auth" ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t("git.githubConnect")}
                  </Button>
                )}
              </div>
              <p className="mt-3 text-sm text-muted-foreground">{githubStatusMessage}</p>
              {githubDeviceFlow ? (
                <div className="mt-4 rounded-xl border border-border/60 bg-background/80 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{t("git.githubCodeLabel")}</p>
                  <p className="mt-2 font-mono text-lg font-semibold text-foreground">{githubDeviceFlow.user_code}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{t("git.githubVerificationHint")}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        if (window.electronAPI?.shell?.openExternal) {
                          void window.electronAPI.shell.openExternal(githubDeviceFlow.verification_uri);
                        }
                      }}
                    >
                      {t("git.githubOpenVerification")}
                    </Button>
                    {githubPolling ? (
                      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        {t("git.githubAwaitingApproval")}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <Input
              value={cloneUrl}
              onChange={(event) => setCloneUrl(event.target.value)}
              placeholder={t("git.repositoryUrl")}
              disabled={pendingAction === "clone"}
            />

            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={cloneDestination}
                onChange={(event) => setCloneDestination(event.target.value)}
                placeholder={t("git.destinationPath")}
                disabled={pendingAction === "clone"}
              />
              {isElectron ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handlePickCloneDestination()}
                  disabled={pendingAction === "clone"}
                >
                  {t("git.cloneBrowse")}
                </Button>
              ) : null}
            </div>

            {cloneProgress ? (
              <div className="rounded-2xl border border-border/60 bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>{t("git.cloneProgress")}</span>
                  <span>{cloneProgress.percent != null ? `${cloneProgress.percent}%` : ""}</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-border/50">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.max(6, Math.min(100, cloneProgress.percent ?? 12))}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{cloneProgress.message}</p>
              </div>
            ) : null}

            <Button
              type="button"
              variant="outline"
              onClick={handleClone}
              disabled={!cloneUrl.trim() || !cloneDestination.trim() || pendingAction === "clone"}
            >
              {pendingAction === "clone" ? <Loader2 className="size-4 animate-spin" /> : <Github className="size-4" />}
              {t("git.clone")}
            </Button>
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
            {t("git.cloneRemoteBlocked")}
          </div>
        )}
      </CardContent>
    </Card>
  );

  if (!context) {
    return (
      <Card className="gap-4">
        <CardHeader>
          <CardTitle>{t("git.noWorkspace")}</CardTitle>
          <CardDescription>{t("git.description")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (loading && !status) {
    return (
      <div className="flex h-[28rem] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const repoStatus = status && status.is_repo ? status : null;
  const alerts = (
    <>
      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>{t("git.lastError")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert>
          <Sparkles className="size-4" />
          <AlertTitle>{t("git.noticeTitle")}</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );

  if (!repoStatus) {
    return (
      <div className="space-y-4">
        {alerts}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <Card className="gap-4">
            <CardHeader className="border-b">
              <CardTitle>{t("git.notRepoTitle")}</CardTitle>
              <CardDescription>{t("git.notRepoBody")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button type="button" onClick={handleInitRepo} disabled={pendingAction === "init"}>
                {pendingAction === "init" ? <Loader2 className="size-4 animate-spin" /> : <FolderGit2 className="size-4" />}
                {t("git.initRepo")}
              </Button>
              <p className="text-sm text-muted-foreground">
                {workspaceMode === "remote" ? t("git.initRepoRemoteHint") : t("git.initRepoLocalHint")}
              </p>
            </CardContent>
          </Card>

          {cloneCard}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {alerts}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)]">
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <GitStatusBar
              status={repoStatus}
              workspaceMode={workspaceMode}
              refreshing={refreshing}
              onRefresh={() => void refreshAll(true)}
            />
            <GitPushPullBar
              workspaceMode={workspaceMode}
              disabled={false}
              pendingAction={pendingAction}
              onPush={handlePush}
              onPull={handlePull}
              onFetch={handleFetch}
            />
          </div>

          <GitBranchSelector
            branches={branches}
            pendingAction={pendingAction}
            onCheckout={handleCheckoutBranch}
            onCreate={handleCreateBranch}
            onDelete={handleDeleteBranch}
          />

          <GitChanges
            status={repoStatus}
            pendingAction={pendingAction}
            selectedDiffKey={selectedDiffKey}
            onPreview={handlePreviewFile}
            onStage={handleStage}
            onUnstage={handleUnstage}
            onStageAll={handleStageAll}
          />

          <GitLogView
            entries={entries}
            selectedSha={diffSelection?.kind === "commit" ? diffSelection.sha : ""}
            loading={loading}
            onSelectCommit={handlePreviewCommit}
          />
        </div>

        <div className="space-y-4">
          <GitCommitForm
            message={commitMessage}
            stagedCount={repoStatus.staged_count}
            suggestionSummary={commitSummary}
            generating={pendingAction === "generate-commit"}
            committing={pendingAction === "commit"}
            onMessageChange={setCommitMessage}
            onGenerate={handleGenerateCommit}
            onCommit={handleCreateCommit}
          />

          <GitDiffView title={diffTitle} diff={diff} loading={diffLoading} />

          <GitRemoteManager
            remotes={remotes}
            pendingAction={pendingAction}
            onAdd={handleAddRemote}
            onRemove={handleRemoveRemote}
          />

          {cloneCard}
        </div>
      </div>
    </div>
  );
}
