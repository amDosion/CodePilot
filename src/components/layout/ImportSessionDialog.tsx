"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Search01Icon,
  Loading02Icon,
  FolderOpenIcon,
  GitBranchIcon,
  ClockIcon,
  FileImportIcon,
  MessageAddIcon,
} from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";
import { normalizeEngineType } from "@/lib/engine-defaults";
import { cn, parseDBDate } from "@/lib/utils";

import type { WorkspaceMode } from "@/hooks/usePanel";

interface CliSessionInfo {
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
  model?: string;
  engineType?: "claude" | "codex" | "gemini";
  /** Remote-only: directory name for building the import file path */
  dirName?: string;
}

interface ImportSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  engineType?: "claude" | "codex" | "gemini";
  workspaceMode?: WorkspaceMode;
  connectionId?: string;
}

function formatRelativeTime(dateStr: string): { key: 'import.justNow' | 'import.minutesAgo' | 'import.hoursAgo' | 'import.daysAgo'; params?: Record<string, number> } | string {
  const date = parseDBDate(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return { key: 'import.justNow' };
  if (diffMin < 60) return { key: 'import.minutesAgo', params: { n: diffMin } };
  if (diffHr < 24) return { key: 'import.hoursAgo', params: { n: diffHr } };
  if (diffDay < 7) return { key: 'import.daysAgo', params: { n: diffDay } };
  return date.toLocaleDateString();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getRuntimeLabel(
  t: ReturnType<typeof useTranslation>["t"],
  engineType: "claude" | "codex" | "gemini"
): string {
  if (engineType === "codex") return t("chatList.providerCodex");
  if (engineType === "gemini") return t("chatList.providerGemini");
  return t("chatList.providerClaude");
}

export function ImportSessionDialog({
  open,
  onOpenChange,
  engineType = "claude",
  workspaceMode = "local",
  connectionId,
}: ImportSessionDialogProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<CliSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedEngineType = normalizeEngineType(engineType);
  const isCodex = normalizedEngineType === "codex";
  const isGemini = normalizedEngineType === "gemini";
  const isRemote = workspaceMode === "remote";
  const providerName = useMemo(
    () => (isCodex ? t("chatList.providerCodex") : isGemini ? t("chatList.providerGemini") : t("chatList.providerClaude")),
    [isCodex, isGemini, t]
  );
  const cliName = useMemo(
    () => (isCodex ? t("import.codexCli") : isGemini ? t("import.geminiCli") : t("import.claudeCli")),
    [isCodex, isGemini, t]
  );
  const localApiBase = isCodex ? "/api/codex-sessions" : isGemini ? "/api/gemini-sessions" : "/api/claude-sessions";
  const sessionsPath = isCodex ? "~/.codex/sessions/" : isGemini ? "~/.gemini/tmp/<project>/chats/" : "~/.claude/projects/";

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let res: Response;
      if (isRemote) {
        const cid = connectionId || (typeof window !== 'undefined'
          ? localStorage.getItem('codepilot:last-remote-connection-id') : null);
        if (!cid) {
          setError("No remote connection available");
          setLoading(false);
          return;
        }
        res = await fetch("/api/remote/cli-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connection_id: cid, engine_type: normalizedEngineType }),
        });
      } else {
        res = await fetch(localApiBase);
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to fetch sessions");
      }
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [localApiBase, isRemote, connectionId, normalizedEngineType]);

  useEffect(() => {
    if (open) {
      fetchSessions();
    }
  }, [open, fetchSessions, normalizedEngineType]);

  const handleImport = async (session: CliSessionInfo) => {
    setImporting(session.sessionId);
    setError(null);
    try {
      let res: Response;
      if (isRemote) {
        const cid = connectionId || (typeof window !== 'undefined'
          ? localStorage.getItem('codepilot:last-remote-connection-id') : null);
        res = await fetch("/api/remote/cli-sessions/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connection_id: cid,
            engine_type: normalizedEngineType,
            session_id: session.sessionId,
            dir_name: session.dirName || '',
          }),
        });
      } else {
        res = await fetch(`${localApiBase}/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.sessionId }),
        });
      }

      const data = await res.json();

      if (res.status === 409 && data.existingSessionId) {
        onOpenChange(false);
        router.push(`/chat/${data.existingSessionId}`);
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || "Failed to import session");
      }

      onOpenChange(false);
      window.dispatchEvent(new CustomEvent("session-created"));
      router.push(`/chat/${data.session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import session");
    } finally {
      setImporting(null);
    }
  };

  const filteredSessions = searchQuery
    ? sessions.filter(
        (s) =>
          s.projectName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.preview.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.cwd.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.gitBranch.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (s.model || "").toLowerCase().includes(searchQuery.toLowerCase())
      )
    : sessions;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] !flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={FileImportIcon}
              className="h-5 w-5 text-primary"
            />
            {t("import.title", { provider: cliName })}
            {isRemote && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 ml-1">SSH</Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {t("import.description", { provider: cliName })}
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder={t('import.searchSessions')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 text-sm"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Session List */}
        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6">
          <div className="flex flex-col gap-2 pb-2">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="h-5 w-5 animate-spin text-muted-foreground"
                />
                <span className="ml-2 text-sm text-muted-foreground">
                  {t("import.scanning", { provider: providerName })}
                </span>
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <HugeiconsIcon
                  icon={FolderOpenIcon}
                  className="h-8 w-8 mb-2 opacity-40"
                />
                <p className="text-sm">
                  {searchQuery
                    ? t('import.noSessions')
                    : t('import.noSessions')}
                </p>
                <p className="text-xs mt-1 opacity-60">
                  {searchQuery
                    ? t("import.tryDifferentSearch")
                    : t("import.pathHint", { path: sessionsPath })}
                </p>
              </div>
            ) : (
              filteredSessions.map((session) => {
                const isImporting = importing === session.sessionId;
                const totalMessages =
                  session.userMessageCount + session.assistantMessageCount;
                const sessionEngineType = normalizeEngineType(
                  session.engineType || normalizedEngineType
                );
                const runtimeLabel = getRuntimeLabel(t, sessionEngineType);
                return (
                  <div
                    key={session.sessionId}
                    className={cn(
                      "group flex flex-col gap-1.5 rounded-lg border p-3 transition-colors",
                      "hover:bg-accent/50",
                      isImporting && "opacity-60 pointer-events-none"
                    )}
                  >
                    {/* Top row: project name + import button */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-sm truncate">
                            {session.projectName}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                          >
                            {runtimeLabel}
                          </Badge>
                          {session.model && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0 h-4 shrink-0 max-w-[180px] truncate"
                              title={session.model}
                            >
                              {session.model}
                            </Badge>
                          )}
                          {session.gitBranch && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                            >
                              <HugeiconsIcon
                                icon={GitBranchIcon}
                                className="h-2.5 w-2.5 mr-0.5"
                              />
                              {session.gitBranch}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2 break-all">
                          {session.preview}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 h-7 text-xs"
                        onClick={() => handleImport(session)}
                        disabled={isImporting}
                      >
                        {isImporting ? (
                          <>
                            <HugeiconsIcon
                              icon={Loading02Icon}
                              className="h-3 w-3 mr-1 animate-spin"
                            />
                            {t('import.importing')}
                          </>
                        ) : (
                          <>
                            <HugeiconsIcon
                              icon={FileImportIcon}
                              className="h-3 w-3 mr-1"
                            />
                            {t('import.import')}
                          </>
                        )}
                      </Button>
                    </div>

                    {/* Bottom row: metadata */}
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
                      <span
                        className="flex items-center gap-0.5 truncate"
                        title={session.cwd}
                      >
                        <HugeiconsIcon
                          icon={FolderOpenIcon}
                          className="h-2.5 w-2.5 shrink-0"
                        />
                        {session.cwd}
                      </span>
                      <span className="flex items-center gap-0.5 shrink-0">
                        <HugeiconsIcon
                          icon={MessageAddIcon}
                          className="h-2.5 w-2.5"
                        />
                        {t(totalMessages !== 1 ? 'import.messagesPlural' : 'import.messages', { n: totalMessages })}
                      </span>
                      <span className="flex items-center gap-0.5 shrink-0">
                        <HugeiconsIcon
                          icon={ClockIcon}
                          className="h-2.5 w-2.5"
                        />
                        {(() => {
                          const rel = formatRelativeTime(session.updatedAt);
                          return typeof rel === 'string' ? rel : t(rel.key, rel.params);
                        })()}
                      </span>
                      <span className="shrink-0">
                        {formatFileSize(session.fileSize)}
                      </span>
                      {session.version && (
                        <span className="shrink-0">v{session.version}</span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
