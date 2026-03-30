"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import { InstallWizard } from "@/components/layout/InstallWizard";
import { usePanel } from "@/hooks/usePanel";
import { buildEnginePreferenceTarget, readActiveEngine } from "@/lib/engine-preferences";

type RuntimeEngine = 'claude' | 'codex' | 'gemini';

interface EngineStatus {
  available: boolean;
  ready: boolean;
  version: string | null;
  detail: string;
}

interface RuntimeStatus {
  connected: boolean;
  engines: Record<RuntimeEngine, EngineStatus>;
}

const BASE_INTERVAL = 30_000; // 30s
const BACKED_OFF_INTERVAL = 60_000; // 60s after 3 consecutive stable results
const STABLE_THRESHOLD = 3;

export function ConnectionStatus() {
  const { t } = useTranslation();
  const {
    workspaceMode,
    remoteConnectionId,
    remoteConnectionReady,
    remoteConnectionState,
    setRemoteConnectionReady,
    setRemoteConnectionState,
  } = usePanel();
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [activeEngine, setActiveEngine] = useState<RuntimeEngine>('claude');
  const isRemoteWorkspace = workspaceMode === 'remote';

  const isElectron =
    typeof window !== "undefined" &&
    !!window.electronAPI?.install;
  const stableCountRef = useRef(0);
  const lastConnectedRef = useRef<boolean | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoPromptedRef = useRef(false);

  // Use a ref-based approach to avoid circular deps between check and schedule
  const checkRef = useRef<() => void>(() => {});

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const interval = stableCountRef.current >= STABLE_THRESHOLD
      ? BACKED_OFF_INTERVAL
      : BASE_INTERVAL;
    timerRef.current = setTimeout(() => checkRef.current(), interval);
  }, []);

  const readStoredEngine = useCallback((): RuntimeEngine => {
    return readActiveEngine(buildEnginePreferenceTarget(
      workspaceMode === 'remote' ? 'remote' : 'local',
      remoteConnectionId,
    ));
  }, [workspaceMode, remoteConnectionId]);

  const getEngineLabel = useCallback((engine: RuntimeEngine) => {
    switch (engine) {
      case 'codex':
        return t("chatList.providerCodex");
      case 'gemini':
        return t("chatList.providerGemini");
      default:
        return t("chatList.providerClaude");
    }
  }, [t]);

  const getSetupSections = useCallback((selectedEngine: RuntimeEngine) => {
    const sections: Array<{
      engine: RuntimeEngine;
      title: string;
      commands: string[];
      hint: string;
    }> = [
      {
        engine: "claude",
        title: `${getEngineLabel("claude")} setup`,
        commands: [
          "npm install -g @anthropic-ai/claude-code",
          "claude login",
          "claude --version",
        ],
        hint: "Authenticate with Claude Code before using this runtime.",
      },
      {
        engine: "codex",
        title: `${getEngineLabel("codex")} setup`,
        commands: [
          "codex login",
          "codex --version",
        ],
        hint: "ChatGPT login is the preferred path. API-key based setup is optional.",
      },
      {
        engine: "gemini",
        title: `${getEngineLabel("gemini")} setup`,
        commands: [
          "npm install -g @google/gemini-cli",
          "gemini",
          "gemini --version",
        ],
        hint: "Complete interactive auth, configure ~/.gemini/settings.json, or set GEMINI_API_KEY.",
      },
    ];

    return [
      ...sections.filter((section) => section.engine === selectedEngine),
      ...sections.filter((section) => section.engine !== selectedEngine),
    ];
  }, [getEngineLabel]);

  const checkStatus = useCallback(async () => {
    const preferredEngine = readStoredEngine();
    setActiveEngine(preferredEngine);

    if (isRemoteWorkspace && !remoteConnectionId) {
      setStatus({
        connected: false,
        engines: {
          claude: { available: false, ready: false, version: null, detail: 'Remote connection unavailable.' },
          codex: { available: false, ready: false, version: null, detail: 'Remote connection unavailable.' },
          gemini: { available: false, ready: false, version: null, detail: 'Remote connection unavailable.' },
        },
      });
      schedule();
      return;
    }

    if (isRemoteWorkspace && !remoteConnectionReady) {
      const detail = remoteConnectionState === 'reconnecting'
        ? 'Remote SSH connection is reconnecting.'
        : remoteConnectionState === 'checking'
          ? 'Checking remote SSH connection.'
          : remoteConnectionState === 'idle'
            ? 'Select a remote connection before using the remote workspace.'
            : remoteConnectionState === 'disconnected'
              ? 'Remote SSH connection is disconnected.'
              : 'Remote SSH connection is unavailable.';
      setStatus({
        connected: false,
        engines: {
          claude: { available: false, ready: false, version: null, detail },
          codex: { available: false, ready: false, version: null, detail },
          gemini: { available: false, ready: false, version: null, detail },
        },
      });
      schedule();
      return;
    }

    try {
      const res = isRemoteWorkspace
        ? await fetch("/api/remote/runtime-status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connection_id: remoteConnectionId }),
          })
        : await fetch("/api/runtime-status");
      if (res.ok) {
        const data: RuntimeStatus = await res.json();
        const nextConnected = !!data.engines?.[preferredEngine]?.ready;
        if (lastConnectedRef.current === nextConnected) {
          stableCountRef.current++;
        } else {
          stableCountRef.current = 0;
        }
        lastConnectedRef.current = nextConnected;
        setStatus(data);
      }
    } catch {
      if (lastConnectedRef.current === false) {
        stableCountRef.current++;
      } else {
        stableCountRef.current = 0;
      }
      lastConnectedRef.current = false;
        setStatus({
          connected: false,
          engines: {
            claude: { available: false, ready: false, version: null, detail: 'Claude runtime unavailable.' },
            codex: { available: false, ready: false, version: null, detail: 'Codex runtime unavailable.' },
            gemini: { available: false, ready: false, version: null, detail: 'Gemini runtime unavailable.' },
        },
      });
    }
    schedule();
  }, [
    isRemoteWorkspace,
    readStoredEngine,
    remoteConnectionId,
    remoteConnectionReady,
    remoteConnectionState,
    schedule,
  ]);

  useEffect(() => {
    checkRef.current = checkStatus;
  }, [checkStatus]);

  useEffect(() => {
    setStatus(null);
    stableCountRef.current = 0;
    lastConnectedRef.current = null;
    checkStatus();  
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [checkStatus, workspaceMode, remoteConnectionId]);

  useEffect(() => {
    const handleRuntimeSelectionChange = () => {
      stableCountRef.current = 0;
      lastConnectedRef.current = null;
      setStatus(null);
      checkStatus();
    };

    window.addEventListener('engine-changed', handleRuntimeSelectionChange);
    window.addEventListener('focus', handleRuntimeSelectionChange);
    return () => {
      window.removeEventListener('engine-changed', handleRuntimeSelectionChange);
      window.removeEventListener('focus', handleRuntimeSelectionChange);
    };
  }, [checkStatus]);

  const handleManualRefresh = useCallback(async () => {
    stableCountRef.current = 0;
    if (isRemoteWorkspace && remoteConnectionId) {
      setRemoteConnectionReady(false);
      setRemoteConnectionState('checking');
      try {
        const res = await fetch(`/api/remote/connections/${remoteConnectionId}/health`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'check' }),
        });
        if (!res.ok) {
          throw new Error('Remote health check failed');
        }
        const data = await res.json() as { health?: { healthy?: boolean } };
        if (data.health?.healthy) {
          setRemoteConnectionReady(true);
          setRemoteConnectionState('ready');
        } else {
          setRemoteConnectionReady(false);
          setRemoteConnectionState('disconnected');
        }
      } catch {
        setRemoteConnectionReady(false);
        setRemoteConnectionState('error');
      }
    }
    checkStatus();
  }, [
    checkStatus,
    isRemoteWorkspace,
    remoteConnectionId,
    setRemoteConnectionReady,
    setRemoteConnectionState,
  ]);

  // Auto-prompt install wizard on first disconnect detection (Electron only)
  useEffect(() => {
    const activeReady = activeEngine === 'codex'
      ? !!status?.engines?.codex?.ready
      : activeEngine === 'gemini'
        ? !!status?.engines?.gemini?.ready
        : !!status?.engines?.claude?.ready;
    if (
      status !== null &&
      !activeReady &&
      isElectron &&
      !isRemoteWorkspace &&
      activeEngine === 'claude' &&
      !autoPromptedRef.current &&
      !dialogOpen &&
      !wizardOpen
    ) {
      const dismissed = localStorage.getItem("codepilot:install-wizard-dismissed");
      if (!dismissed) {
        autoPromptedRef.current = true;
        setWizardOpen(true);  
      }
    }
  }, [status, isElectron, dialogOpen, wizardOpen, activeEngine, isRemoteWorkspace]);

  const handleWizardOpenChange = useCallback((open: boolean) => {
    setWizardOpen(open);
    if (!open) {
      // Remember that user dismissed the wizard so we don't auto-prompt again
      localStorage.setItem("codepilot:install-wizard-dismissed", "1");
    }
  }, []);

  const transportChecking = isRemoteWorkspace
    ? remoteConnectionState === 'checking' || remoteConnectionState === 'reconnecting'
    : false;
  const isChecking = isRemoteWorkspace
    ? transportChecking || (remoteConnectionReady && status === null)
    : status === null;
  const connected = isRemoteWorkspace
    ? remoteConnectionReady
    : !isChecking && !!status?.engines?.[activeEngine]?.ready;
  const activeStatus = status?.engines?.[activeEngine];
  const setupSections = getSetupSections(activeEngine);
  const remoteTransportDescription = !isRemoteWorkspace
    ? ''
    : remoteConnectionState === 'checking'
      ? t('connection.checkingDetailRemote')
      : remoteConnectionState === 'reconnecting'
        ? t('remote.healthReconnecting')
        : remoteConnectionState === 'ready'
          ? t('remote.healthConnected')
          : remoteConnectionState === 'idle'
            ? t('chat.remoteConnectionRequired')
            : remoteConnectionState === 'disconnected'
              ? t('remote.healthDisconnected')
              : (activeStatus?.detail || t('chat.remoteRuntimeFailed'));
  const transportTitle = isRemoteWorkspace
    ? t('chat.remoteConnection')
    : '';
  const transportBadgeLabel = isRemoteWorkspace
    ? (transportChecking
      ? t('connection.checking')
      : connected
        ? t('connection.connected')
        : t('connection.disconnected'))
    : '';

  return (
    <>
      <button
        onClick={() => setDialogOpen(true)}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-colors",
          isChecking
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
            : connected
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
              : "bg-red-500/15 text-red-700 dark:text-red-400"
        )}
      >
        <span
          className={cn(
            "block h-1.5 w-1.5 shrink-0 rounded-full",
            isChecking
              ? "animate-pulse bg-amber-500"
              : connected
                ? "bg-emerald-500"
                : "bg-red-500"
          )}
        />
        {isChecking
          ? t('connection.checking')
          : connected
            ? t('connection.connected')
            : t('connection.disconnected')}
      </button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {isChecking
                ? t('connection.checking')
                : isRemoteWorkspace
                ? t('chat.remoteRuntimeTitle')
                : connected
                  ? t('connection.installed')
                  : t('connection.notInstalled')}
            </DialogTitle>
            <DialogDescription>
              {isChecking
                ? (isRemoteWorkspace ? t('connection.checkingDetailRemote') : t('connection.checkingDetailLocal'))
                : isRemoteWorkspace
                ? remoteTransportDescription
                : connected
                ? `${getEngineLabel(activeEngine)} is ready.`
                : (activeStatus?.detail || 'Selected runtime is not ready.')}
            </DialogDescription>
          </DialogHeader>

          {isChecking ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-3 rounded-lg bg-amber-500/10 px-4 py-3">
                <span className="block h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500 animate-pulse" />
                <div>
                  <p className="font-medium text-amber-700 dark:text-amber-400">
                    {t('connection.checking')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {isRemoteWorkspace ? t('connection.checkingDetailRemote') : t('connection.checkingDetailLocal')}
                  </p>
                </div>
              </div>
            </div>
          ) : connected || isRemoteWorkspace ? (
            <div className="space-y-3 text-sm">
              {isRemoteWorkspace && (
                <div
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-4 py-3",
                    connected ? "bg-blue-500/10" : "bg-muted/60"
                  )}
                >
                  <span
                    className={cn(
                      "block h-2.5 w-2.5 shrink-0 rounded-full",
                      transportChecking
                        ? "animate-pulse bg-amber-500"
                        : connected
                          ? "bg-blue-500"
                          : "bg-red-500"
                    )}
                  />
                  <div>
                    <p className={cn(
                      "font-medium",
                      connected ? "text-blue-700 dark:text-blue-400" : "text-muted-foreground"
                    )}>
                      {transportTitle}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {transportBadgeLabel}
                      {remoteConnectionId ? ` · ${remoteConnectionId}` : ''}
                    </p>
                  </div>
                </div>
              )}
              {(['claude', 'codex', 'gemini'] as const).map((engine) => {
                const engineStatus = status?.engines?.[engine];
                const ready = !!engineStatus?.ready;
                return (
                  <div
                    key={engine}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-4 py-3",
                      ready ? "bg-emerald-500/10" : "bg-muted/60"
                    )}
                  >
                    <span
                      className={cn(
                        "block h-2.5 w-2.5 shrink-0 rounded-full",
                        ready ? "bg-emerald-500" : "bg-muted-foreground/40"
                      )}
                    />
                    <div>
                      <p className={cn(
                        "font-medium",
                        ready ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"
                      )}>
                        {getEngineLabel(engine)}
                        {activeEngine === engine ? ' (selected)' : ''}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {engineStatus?.version ? `v${engineStatus.version}` : engineStatus?.detail}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="flex items-center gap-3 rounded-lg bg-red-500/10 px-4 py-3">
                <span className="block h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />
                <div>
                  <p className="font-medium text-red-700 dark:text-red-400">
                    {getEngineLabel(activeEngine)} not ready
                  </p>
                  <p className="text-xs text-muted-foreground">{activeStatus?.detail}</p>
                </div>
              </div>

              {setupSections.map((section) => (
                <div key={section.engine}>
                  <h4 className="font-medium mb-1.5">
                    {section.title}
                    {section.engine === activeEngine ? " (selected)" : ""}
                  </h4>
                  {section.commands.map((command) => (
                    <code
                      key={command}
                      className="mt-1.5 block rounded-md bg-muted px-3 py-2 text-xs first:mt-0"
                    >
                      {command}
                    </code>
                  ))}
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {section.hint}
                  </p>
                </div>
              ))}

              {isElectron && !isRemoteWorkspace && activeEngine === 'claude' && (
                <div className="pt-2 border-t">
                  <Button
                    onClick={() => {
                      setDialogOpen(false);
                      setWizardOpen(true);
                    }}
                    className="w-full"
                  >
                    {t('connection.installAuto')}
                  </Button>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleManualRefresh}
            >
              {t('connection.refresh')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InstallWizard
        open={wizardOpen}
        onOpenChange={handleWizardOpenChange}
        onInstallComplete={handleManualRefresh}
      />
    </>
  );
}
