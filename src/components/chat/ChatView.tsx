'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { Message, MessagesResponse, FileAttachment, SessionStreamSnapshot } from '@/types';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { usePanel } from '@/hooks/usePanel';
import { useTranslation } from '@/hooks/useTranslation';
import { useTheme } from 'next-themes';
import { useRuntimeCommands } from '@/hooks/useRuntimeCommands';
import { useNativeCommandController } from '@/hooks/useNativeCommandController';
import { BatchExecutionDashboard, BatchContextSync } from './batch-image-gen';
import { setLastGeneratedImages, transferPendingToMessage } from '@/lib/image-ref-store';
import {
  startStream,
  stopStream,
  subscribe,
  getSnapshot,
  respondToPermission,
  clearSnapshot,
} from '@/lib/stream-session-manager';
import {
  normalizeEngineType,
  normalizeReasoningEffort,
} from '@/lib/engine-defaults';
import {
  buildEnginePreferenceTarget,
  persistEnginePreferences,
  readActiveEngine,
  readEnginePreferences,
} from '@/lib/engine-preferences';
import { buildInteractiveContent } from '@/lib/command-select-builder';
import { routeCommand } from '@/lib/command-dispatcher';
import { handleLocalCommand, handleCliOnlyCommand, type LocalCommandContext, type LocalCommandAction } from '@/lib/local-command-handlers';
import { useDefaultModel, useDefaultReasoningEffort } from '@/hooks/useCliDefaults';

interface ChatViewProps {
  sessionId: string;
  initialMessages?: Message[];
  initialHasMore?: boolean;
  modelName?: string;
  reasoningEffort?: string;
  initialMode?: string;
  providerId?: string;
  engineType?: string;
  workspaceTransport?: 'local' | 'ssh_direct';
  remoteConnectionId?: string;
}

function getForkRedirectPayload(data: unknown): { sessionId: string; workingDirectory: string } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const sessionId = (data as Record<string, unknown>).new_session_id;
  if (typeof sessionId !== 'string' || !sessionId) return null;

  const workingDirectory = (data as Record<string, unknown>).working_directory;
  return {
    sessionId,
    workingDirectory: typeof workingDirectory === 'string' ? workingDirectory : '',
  };
}

export function ChatView({
  sessionId,
  initialMessages = [],
  initialHasMore = false,
  modelName,
  reasoningEffort,
  initialMode,
  providerId,
  engineType,
  workspaceTransport = 'local',
  remoteConnectionId = '',
}: ChatViewProps) {
  const router = useRouter();
  const {
    setStreamingSessionId,
    workingDirectory,
    setPendingApprovalSessionId,
    setSessionId,
    setWorkingDirectory,
    setPanelOpen,
  } = usePanel();
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [mode, setMode] = useState(initialMode || 'code');
  const initialEngineType = normalizeEngineType(engineType || 'claude');
  const cliDefaultModel = useDefaultModel(initialEngineType);
  const cliDefaultReasoning = useDefaultReasoningEffort(initialEngineType);
  const [currentEngineType, setCurrentEngineType] = useState(initialEngineType);
  const [currentModel, setCurrentModel] = useState(
    modelName || cliDefaultModel
  );
  const [currentProviderId, setCurrentProviderId] = useState(
    providerId || ((initialEngineType === 'codex' || initialEngineType === 'gemini') ? 'env' : '')
  );
  const [currentReasoningEffort, setCurrentReasoningEffort] = useState<string>(
    normalizeReasoningEffort(reasoningEffort || '')
    || cliDefaultReasoning
  );
  const [currentApprovalPolicy, setCurrentApprovalPolicy] = useState<string>('suggest');
  const preferenceTarget = useMemo(
    () => buildEnginePreferenceTarget(
      workspaceTransport === 'ssh_direct' ? 'remote' : 'local',
      remoteConnectionId,
    ),
    [remoteConnectionId, workspaceTransport],
  );
  const runtimeCommands = useRuntimeCommands(currentEngineType);
  const nativeCommandContext = useMemo(() => ({
    mode,
    model: currentModel,
    provider_id: currentProviderId,
    reasoning_effort: currentReasoningEffort,
    working_directory: workingDirectory,
  }), [mode, currentModel, currentProviderId, currentReasoningEffort, workingDirectory]);
  const {
    nativeCommandNames,
    dispatchNativeManagedCommand,
  } = useNativeCommandController({
    sessionId,
    engineType: currentEngineType,
    context: nativeCommandContext,
  });

  // Sync model/provider when session data loads (props update after async fetch)
  // Unconditional: when modelName is empty (old session with no saved model),
  // fall back to localStorage or default to avoid stale values from previous session.
  useEffect(() => {
    const nextEngine = normalizeEngineType(engineType || 'claude');
    const nextPreferences = readEnginePreferences(nextEngine, preferenceTarget, { model: cliDefaultModel, reasoningEffort: cliDefaultReasoning });
    setCurrentModel(
      modelName || nextPreferences.model
    );
  }, [engineType, modelName]);
  useEffect(() => {
    const nextEngine = normalizeEngineType(engineType || 'claude');
    const nextPreferences = readEnginePreferences(nextEngine, preferenceTarget, { model: cliDefaultModel, reasoningEffort: cliDefaultReasoning });
    setCurrentProviderId(
      providerId || nextPreferences.providerId
    );
  }, [engineType, providerId]);
  useEffect(() => {
    const nextEngine = normalizeEngineType(
      engineType || readActiveEngine(preferenceTarget) || 'claude'
    );
    setCurrentEngineType(nextEngine);
  }, [engineType]);
  useEffect(() => {
    const nextEngine = normalizeEngineType(engineType || 'claude');
    const nextPreferences = readEnginePreferences(nextEngine, preferenceTarget, { model: cliDefaultModel, reasoningEffort: cliDefaultReasoning });
    const nextReasoning = reasoningEffort || nextPreferences.reasoningEffort;
    setCurrentReasoningEffort(nextEngine === 'codex' ? nextReasoning : '');
  }, [engineType, reasoningEffort]);

  // Stream snapshot from the manager — drives all streaming UI
  const [streamSnapshot, setStreamSnapshot] = useState<SessionStreamSnapshot | null>(
    () => getSnapshot(sessionId)
  );
  const consumedTerminalGenerationsRef = useRef<Set<string>>(new Set());

  // Derive rendering state from snapshot (backward-compatible with MessageList props)
  const isStreaming = streamSnapshot?.phase === 'active';
  const streamingContent = streamSnapshot?.streamingContent ?? '';
  const toolUses = streamSnapshot?.toolUses ?? [];
  const toolResults = streamSnapshot?.toolResults ?? [];
  const streamingToolOutput = streamSnapshot?.streamingToolOutput ?? '';
  const statusText = streamSnapshot?.statusText;
  const pendingPermission = streamSnapshot?.pendingPermission ?? null;
  const permissionResolved = streamSnapshot?.permissionResolved ?? null;

  // Pending image generation notices — flushed into the next user message so the LLM knows about generated images
  const pendingImageNoticesRef = useRef<string[]>([]);
  // Ref for sendMessage to allow self-referencing in timeout auto-retry
  const sendMessageRef = useRef<(content: string, files?: FileAttachment[]) => Promise<void>>(undefined);

  const consumeTerminalSnapshot = useCallback((snapshot: SessionStreamSnapshot) => {
    const generationKey = `${sessionId}:${snapshot.generation}`;
    if (consumedTerminalGenerationsRef.current.has(generationKey)) {
      clearSnapshot(sessionId, snapshot.generation);
      return;
    }

    consumedTerminalGenerationsRef.current.add(generationKey);
    setStreamingSessionId('');
    setPendingApprovalSessionId('');

    if (snapshot.finalMessageContent) {
      const assistantMessage: Message = {
        id: 'temp-assistant-' + Date.now(),
        session_id: sessionId,
        role: 'assistant',
        content: snapshot.finalMessageContent,
        created_at: new Date().toISOString(),
        token_usage: snapshot.tokenUsage ? JSON.stringify(snapshot.tokenUsage) : null,
      };
      transferPendingToMessage(assistantMessage.id);
      setMessages((prev) => [...prev, assistantMessage]);
    }

    clearSnapshot(sessionId, snapshot.generation);
    setStreamSnapshot(null);
  }, [sessionId, setPendingApprovalSessionId, setStreamingSessionId]);

  const handleModeChange = useCallback((newMode: string) => {
    setMode(newMode);
    // Persist mode to database and notify chat list
    if (sessionId) {
      fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      }).then(() => {
        window.dispatchEvent(new CustomEvent('session-updated'));
      }).catch(() => { /* silent */ });

      // Try to switch SDK permission mode in real-time (works if streaming)
      fetch('/api/chat/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, mode: newMode }),
      }).catch(() => { /* silent — will apply on next message */ });
    }
  }, [sessionId]);

  const handleProviderModelChange = useCallback((newProviderId: string, model: string) => {
    setCurrentProviderId(newProviderId);
    setCurrentModel(model);
    persistEnginePreferences(currentEngineType, { providerId: newProviderId, model }, preferenceTarget);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('engine-changed'));
    }
    // Persist immediately so switching chats preserves the selection
    fetch(`/api/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, provider_id: newProviderId }),
    }).then(() => {
      window.dispatchEvent(new CustomEvent('session-updated', { detail: { id: sessionId } }));
    }).catch(() => {});
  }, [currentEngineType, sessionId]);

  const handleReasoningEffortChange = useCallback((nextReasoningEffort: string) => {
    const normalized = normalizeReasoningEffort(nextReasoningEffort)
      || readEnginePreferences('codex', preferenceTarget, { model: cliDefaultModel, reasoningEffort: cliDefaultReasoning }).reasoningEffort;
    if (!normalized) return;

    setCurrentReasoningEffort(normalized);
    persistEnginePreferences('codex', { reasoningEffort: normalized }, preferenceTarget);
    fetch(`/api/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoning_effort: normalized }),
    }).then(() => {
      window.dispatchEvent(new CustomEvent('session-updated', { detail: { id: sessionId } }));
    }).catch(() => {});
  }, [sessionId]);

  const handleEngineTypeChange = useCallback((nextEngineType: string) => {
    const normalizedEngineType = normalizeEngineType(nextEngineType);
    persistEnginePreferences(currentEngineType, {
      model: currentModel,
      providerId: currentProviderId,
      reasoningEffort: currentReasoningEffort,
    }, preferenceTarget);
    const nextPreferences = readEnginePreferences(normalizedEngineType, preferenceTarget, { model: cliDefaultModel, reasoningEffort: cliDefaultReasoning });
    const nextModel = nextPreferences.model;
    const nextProviderId = nextPreferences.providerId;
    const nextReasoningEffort = normalizedEngineType === 'codex'
      ? nextPreferences.reasoningEffort
      : '';

    setCurrentEngineType(normalizedEngineType);
    setCurrentModel(nextModel);
    setCurrentProviderId(nextProviderId);
    setCurrentReasoningEffort(nextReasoningEffort);
    persistEnginePreferences(normalizedEngineType, {
      model: nextModel,
      providerId: nextProviderId,
      reasoningEffort: nextReasoningEffort,
    }, preferenceTarget);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('engine-changed'));
    }
    fetch(`/api/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine_type: normalizedEngineType,
        model: nextModel,
        provider_id: nextProviderId,
        reasoning_effort: nextReasoningEffort,
      }),
    }).then(() => {
      window.dispatchEvent(new CustomEvent('session-updated', { detail: { id: sessionId } }));
    }).catch(() => {});
  }, [sessionId, currentEngineType, currentModel, currentProviderId, currentReasoningEffort]);

  // Subscribe to stream-session-manager for this session.
  // On unmount we only unsubscribe — we do NOT abort the stream.
  useEffect(() => {
    // Restore snapshot if stream is already active (e.g., user switched away and back)
    const existing = getSnapshot(sessionId);
    if (existing) {
      if (existing.phase === 'active') {
        setStreamSnapshot(existing);
        setStreamingSessionId(sessionId);
        if (existing.pendingPermission && !existing.permissionResolved) {
          setPendingApprovalSessionId(sessionId);
        }
      } else {
        consumeTerminalSnapshot(existing);
      }
    } else {
      setStreamSnapshot(null);
    }

    const unsubscribe = subscribe(sessionId, (event) => {
      setStreamSnapshot(event.snapshot);

      // Sync panel state
      if (event.type === 'phase-changed') {
        if (event.snapshot.phase === 'active') {
          setStreamingSessionId(sessionId);
        } else {
          setStreamingSessionId('');
          setPendingApprovalSessionId('');
        }
      }
      if (event.type === 'permission-request') {
        setPendingApprovalSessionId(sessionId);
      }
      if (event.type === 'completed') {
        consumeTerminalSnapshot(event.snapshot);
      }
    });

    return () => {
      unsubscribe();
      // Do NOT abort — stream continues in the manager
    };
  }, [consumeTerminalSnapshot, sessionId, setStreamingSessionId, setPendingApprovalSessionId]);

  const initializedRef = useRef(false);
  useEffect(() => {
    if (initialMessages.length > 0 && !initializedRef.current) {
      initializedRef.current = true;
      setMessages(initialMessages);
    }
  }, [initialMessages]);

  // Sync mode when session data loads
  useEffect(() => {
    if (initialMode) {
      setMode(initialMode);
    }
  }, [initialMode]);

  // Sync hasMore when initial data loads
  useEffect(() => {
    setHasMore(initialHasMore);
  }, [initialHasMore]);

  const loadEarlierMessages = useCallback(async () => {
    // Use ref as atomic lock to prevent double-fetch from rapid clicks
    if (loadingMoreRef.current || !hasMore || messages.length === 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      // Use _rowid of the earliest message as cursor
      const earliest = messages[0];
      const earliestRowId = (earliest as Message & { _rowid?: number })._rowid;
      if (!earliestRowId) return;
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages?limit=100&before=${earliestRowId}`);
      if (!res.ok) return;
      const data: MessagesResponse = await res.json();
      setHasMore(data.hasMore ?? false);
      if (data.messages.length > 0) {
        setMessages(prev => [...data.messages, ...prev]);
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [sessionId, messages, hasMore]);

  // Stop streaming — delegates to manager
  const stopStreaming = useCallback(() => {
    stopStream(sessionId);
  }, [sessionId]);

  // Permission response — delegates to manager
  const handlePermissionResponse = useCallback(
    async (decision: 'allow' | 'allow_session' | 'deny', updatedInput?: Record<string, unknown>, denyMessage?: string) => {
      setPendingApprovalSessionId('');
      await respondToPermission(sessionId, decision, updatedInput, denyMessage);
    },
    [sessionId, setPendingApprovalSessionId]
  );

  // Send message — delegates stream management to the manager
  const sendMessage = useCallback(
    async (content: string, files?: FileAttachment[], systemPromptAppend?: string, displayOverride?: string) => {
      if (isStreaming) return;

      // Use displayOverride for UI if provided (e.g. image-gen skill injection hides the skill prompt)
      const displayUserContent = displayOverride || content;

      // Build display content: embed file metadata as HTML comment for MessageItem to parse
      let displayContent = displayUserContent;
      if (files && files.length > 0) {
        const fileMeta = files.map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size }));
        displayContent = `<!--files:${JSON.stringify(fileMeta)}-->${displayUserContent}`;
      }

      // Optimistic: add user message to UI immediately
      const userMessage: Message = {
        id: 'temp-' + Date.now(),
        session_id: sessionId,
        role: 'user',
        content: displayContent,
        created_at: new Date().toISOString(),
        token_usage: null,
      };
      setMessages((prev) => [...prev, userMessage]);

      // Flush pending image notices
      const notices = pendingImageNoticesRef.current.length > 0
        ? [...pendingImageNoticesRef.current]
        : undefined;
      if (notices) {
        pendingImageNoticesRef.current = [];
      }

      // Delegate to stream session manager
      startStream({
        sessionId,
        content,
        mode,
        model: currentModel,
        reasoningEffort: currentReasoningEffort,
        providerId: currentProviderId,
        engineType: currentEngineType,
        files,
        systemPromptAppend,
        pendingImageNotices: notices,
        onModeChanged: (sdkMode) => {
          const uiMode = sdkMode === 'plan' ? 'plan' : 'code';
          handleModeChange(uiMode);
        },
        sendMessageFn: (retryContent: string, retryFiles?: FileAttachment[]) => {
          sendMessageRef.current?.(retryContent, retryFiles);
        },
      });
    },
    [sessionId, isStreaming, mode, currentModel, currentReasoningEffort, currentProviderId, currentEngineType, handleModeChange]
  );

  // Keep sendMessageRef in sync so timeout auto-retry can call it
  sendMessageRef.current = sendMessage;

  const appendAssistantMessage = useCallback((content: string) => {
    const message: Message = {
      id: 'cmd-' + Date.now(),
      session_id: sessionId,
      role: 'assistant',
      content,
      created_at: new Date().toISOString(),
      token_usage: null,
    };
    setMessages((prev) => [...prev, message]);
  }, [sessionId]);

  const handleUnknownCommand = useCallback((command: string) => {
    const unknownCommandMessage: Message = {
      id: 'cmd-' + Date.now(),
      session_id: sessionId,
      role: 'assistant',
      content: `## ${t('chat.unknownCommandTitle')}\n\n${t('chat.unknownCommandDesc', { command })}\n\n${t('chat.unknownCommandHelp')}`,
      created_at: new Date().toISOString(),
      token_usage: null,
    };
    setMessages(prev => [...prev, unknownCommandMessage]);
  }, [sessionId, t]);

  const executeLocalActions = useCallback((actions: LocalCommandAction[]) => {
    for (const action of actions) {
      switch (action.type) {
        case 'clearMessages':
          setMessages([]);
          if (sessionId) {
            fetch(`/api/chat/sessions/${sessionId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ clear_messages: true }),
            }).catch(() => { /* silent */ });
          }
          break;
        case 'navigate':
          router.push(action.path);
          break;
        case 'openPanel':
          setPanelOpen(true);
          break;
        case 'switchMode':
          handleModeChange(action.mode);
          break;
        case 'openExternal':
          window.open(action.url, '_blank');
          break;
        case 'toggleTheme': {
          const newTheme = theme === 'dark' ? 'light' : 'dark';
          setTheme(newTheme);
          appendAssistantMessage(newTheme === 'dark' ? 'Switched to **dark** theme.' : 'Switched to **light** theme.');
          break;
        }
        case 'copyLastResponse': {
          const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant?.content) {
            navigator.clipboard.writeText(lastAssistant.content).then(() => {
              appendAssistantMessage(t('chat.copiedToClipboard'));
            }).catch(() => {
              appendAssistantMessage(t('chat.copyFailed'));
            });
          } else {
            appendAssistantMessage(t('chat.nothingToCopy'));
          }
          break;
        }
        case 'openFolderPicker':
          if (window.electronAPI?.dialog?.openFolder) {
            window.electronAPI.dialog.openFolder({ title: 'Add working directory' }).then(result => {
              if (!result.canceled && result.filePaths[0]) {
                appendAssistantMessage(`Added working directory: \`${result.filePaths[0]}\``);
              }
            }).catch(() => appendAssistantMessage('Failed to open folder picker.'));
          } else {
            appendAssistantMessage(t('chat.electronOnlyFeature'));
          }
          break;
        case 'fetchAbout':
          fetch('/api/runtime-status')
            .then(res => res.json())
            .then(statusData => {
              const engineStatus = statusData?.engines?.[currentEngineType];
              appendAssistantMessage(`## About\n\nRuntime: \`${currentEngineType}\`\nVersion: \`${engineStatus?.version || '(unknown)'}\`\nStatus: ${engineStatus?.ready ? '\u2713 ready' : '\u2717 not ready'}`);
            })
            .catch(() => {
              appendAssistantMessage(`## About\n\nRuntime: \`${currentEngineType}\``);
            });
          break;
        case 'fetchModelPicker':
          fetch(`/api/providers/models?engine_type=${encodeURIComponent(currentEngineType)}`)
            .then(res => res.json())
            .then(payload => {
              const models = (payload.groups as Array<{ models: Array<{ value: string; label: string }> }>)
                ?.flatMap(g => g.models) || [];
              const data = { models, active_model: currentModel };
              const interactiveContent = buildInteractiveContent('model', data, sessionId, currentEngineType, currentModel);
              if (interactiveContent) {
                appendAssistantMessage(interactiveContent);
              } else {
                appendAssistantMessage('No models available.');
              }
            })
            .catch(() => {
              appendAssistantMessage('Failed to fetch available models.');
            });
          break;
        case 'fetchOAuthLogin': {
          const oauthEngine = action.engine;
          fetch('/api/cli-auth/oauth/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: oauthEngine }),
          })
            .then(res => res.json())
            .then((data: { session_id: string }) => {
              const sid = data.session_id;
              // Poll for the OAuth URL
              const pollInterval = setInterval(async () => {
                try {
                  const pollRes = await fetch(`/api/cli-auth/oauth/poll?session_id=${sid}&engine=${oauthEngine}`);
                  if (!pollRes.ok) return;
                  const pollData = await pollRes.json() as { status: string; auth_url?: string; error?: string };
                  if (pollData.status === 'url_ready' && pollData.auth_url) {
                    clearInterval(pollInterval);
                    window.open(pollData.auth_url, '_blank');
                    appendAssistantMessage(
                      `## OAuth Login\n\nLogin URL opened in a new tab.\n\nIf it didn't open, click here: [Login Link](${pollData.auth_url})\n\nWaiting for authentication to complete...`
                    );
                    // Continue polling for completion
                    const completionInterval = setInterval(async () => {
                      try {
                        const cRes = await fetch(`/api/cli-auth/oauth/poll?session_id=${sid}&engine=${oauthEngine}`);
                        if (!cRes.ok) return;
                        const cData = await cRes.json() as { status: string; error?: string };
                        if (cData.status === 'completed') {
                          clearInterval(completionInterval);
                          appendAssistantMessage('Login successful! Credentials have been saved.');
                        } else if (cData.status === 'failed') {
                          clearInterval(completionInterval);
                          appendAssistantMessage(`Login failed: ${cData.error || 'Unknown error'}`);
                        }
                      } catch { /* continue polling */ }
                    }, 3000);
                    // Stop completion polling after 5 minutes
                    setTimeout(() => clearInterval(completionInterval), 5 * 60 * 1000);
                  } else if (pollData.status === 'failed') {
                    clearInterval(pollInterval);
                    appendAssistantMessage(`OAuth login failed: ${pollData.error || 'Unknown error'}. Try /login again or use Settings > CLI Runtime.`);
                  }
                } catch { /* continue polling */ }
              }, 2000);
              // Stop URL polling after 30 seconds
              setTimeout(() => clearInterval(pollInterval), 30000);
            })
            .catch(() => {
              appendAssistantMessage('Failed to start OAuth login. Try Settings > CLI Runtime instead.');
            });
          break;
        }
        case 'fetchLogout': {
          const logoutEngine = action.engine;
          fetch('/api/cli-auth/logout', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: logoutEngine }),
          })
            .then(res => res.json())
            .then((data: { engine: string; success: boolean; results: Array<{ description: string; deleted: boolean }> }) => {
              if (data.success) {
                const cleared = data.results.filter(r => r.deleted).map(r => r.description);
                if (cleared.length > 0) {
                  appendAssistantMessage(`## Logged Out\n\nCleared credentials for **${logoutEngine}**:\n${cleared.map(c => '- ' + c).join('\n')}`);
                } else {
                  appendAssistantMessage(`## Logged Out\n\nNo stored credentials found for **${logoutEngine}**. Already logged out.`);
                }
              } else {
                appendAssistantMessage(`Logout failed for **${logoutEngine}**. Check Settings > CLI Runtime for details.`);
              }
            })
            .catch(() => {
              appendAssistantMessage('Failed to process logout. Try Settings > CLI Runtime instead.');
            });
          break;
        }
        case 'fetchIdeStatus': {
          fetch('/api/runtime-status')
            .then(res => res.json())
            .then((statusData: { engines?: Record<string, { ready?: boolean; version?: string }> }) => {
              const engines = statusData?.engines || {};
              const lines: string[] = ['## IDE & Runtime Status', ''];
              const engineNames: Record<string, string> = {
                claude: 'Claude Code',
                codex: 'Codex CLI',
                gemini: 'Gemini CLI',
              };
              for (const [eng, label] of Object.entries(engineNames)) {
                const info = engines[eng];
                if (info) {
                  const status = info.ready ? 'Connected' : 'Not ready';
                  const icon = info.ready ? '\u2705' : '\u274c';
                  lines.push(`${icon} **${label}**: ${status}${info.version ? ' (v' + info.version + ')' : ''}`);
                } else {
                  lines.push(`\u2796 **${label}**: Not configured`);
                }
              }
              lines.push('', 'To manage IDE connections, go to **Settings > CLI Runtime**.');
              appendAssistantMessage(lines.join('\n'));
            })
            .catch(() => {
              appendAssistantMessage('## IDE Status\n\nFailed to fetch runtime status. Go to **Settings > CLI Runtime** to check.');
            });
          break;
        }
      }
    }
  }, [sessionId, router, setPanelOpen, handleModeChange, messages, appendAssistantMessage, t, currentEngineType, currentModel, theme, setTheme]);

  const handleCommand = useCallback(async (command: string) => {
    const route = routeCommand(command, currentEngineType, runtimeCommands);

    switch (route.layer) {
      case 'stream': {
        if (isStreaming) return;
        startStream({
          sessionId,
          content: command.trim(),
          mode,
          model: currentModel,
          reasoningEffort: currentReasoningEffort,
          providerId: currentProviderId,
          engineType: currentEngineType,
          nativeCommand: {
            commandName: route.commandName,
            ...(route.args ? { args: route.args } : {}),
          },
        });
        return;
      }

      case 'native': {
        const nativeDispatch = await dispatchNativeManagedCommand(command);

        if (nativeDispatch.matched && nativeDispatch.handled) {
          const forkRedirect = getForkRedirectPayload(nativeDispatch.data);
          if (forkRedirect) {
            setSessionId(forkRedirect.sessionId);
            if (forkRedirect.workingDirectory) {
              setWorkingDirectory(forkRedirect.workingDirectory);
            }
            setPanelOpen(true);
            window.dispatchEvent(new CustomEvent('session-created', { detail: { id: forkRedirect.sessionId } }));
            router.push(`/chat/${forkRedirect.sessionId}`);
            return;
          }

          if (nativeDispatch.statePatch) {
            const sessionPatch: Record<string, string> = {};
            const statePatch = nativeDispatch.statePatch;

            if (statePatch.model && statePatch.model !== currentModel) {
              setCurrentModel(statePatch.model);
              sessionPatch.model = statePatch.model;
              persistEnginePreferences(currentEngineType, {
                model: statePatch.model,
                providerId: currentProviderId,
                reasoningEffort: currentReasoningEffort,
              }, preferenceTarget);
            }
            if (statePatch.provider_id && statePatch.provider_id !== currentProviderId) {
              setCurrentProviderId(statePatch.provider_id);
              sessionPatch.provider_id = statePatch.provider_id;
              persistEnginePreferences(currentEngineType, {
                model: statePatch.model || currentModel,
                providerId: statePatch.provider_id,
                reasoningEffort: currentReasoningEffort,
              }, preferenceTarget);
            }
            if (statePatch.reasoning_effort && statePatch.reasoning_effort !== currentReasoningEffort) {
              setCurrentReasoningEffort(statePatch.reasoning_effort);
              sessionPatch.reasoning_effort = statePatch.reasoning_effort;
              persistEnginePreferences(currentEngineType, {
                model: statePatch.model || currentModel,
                providerId: statePatch.provider_id || currentProviderId,
                reasoningEffort: statePatch.reasoning_effort,
              }, preferenceTarget);
            }
            if (statePatch.mode && statePatch.mode !== mode) {
              handleModeChange(statePatch.mode);
            }
            if (statePatch.approval_policy && statePatch.approval_policy !== currentApprovalPolicy) {
              setCurrentApprovalPolicy(statePatch.approval_policy);
            }

            if (Object.keys(sessionPatch).length > 0 && sessionId) {
              fetch(`/api/chat/sessions/${sessionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sessionPatch),
              }).catch(() => { /* silent */ });
            }
          }

          // When invoked without args, check if we can show an interactive picker
          if (!route.args && nativeDispatch.data) {
            const interactiveContent = buildInteractiveContent(
              route.commandName, nativeDispatch.data, sessionId, currentEngineType, currentModel,
            );
            if (interactiveContent) {
              appendAssistantMessage(interactiveContent);
              return;
            }
          }

          appendAssistantMessage(nativeDispatch.message);
          return;
        }
        // Native dispatch matched but not handled (e.g. no active runtime) — show error
        if (nativeDispatch.matched && !nativeDispatch.handled) {
          appendAssistantMessage(nativeDispatch.message);
          return;
        }
        // Not matched by native controller — should not happen with correct metadata,
        // but fall back to showing the message if there is one
        if (nativeDispatch.message) {
          appendAssistantMessage(nativeDispatch.message);
        }
        return;
      }

      case 'local': {
        const localCtx: LocalCommandContext = {
          sessionId,
          engineType: currentEngineType,
          messages,
          currentModel,
          currentProviderId,
          currentReasoningEffort,
          currentApprovalPolicy,
          mode,
          workingDirectory,
          runtimeCommands,
          t,
        };
        const localResult = handleLocalCommand(route.commandName, route.args, localCtx);
        if (localResult) {
          if (localResult.message) appendAssistantMessage(localResult.message);
          if (localResult.actions) executeLocalActions(localResult.actions);
        }
        return;
      }

      case 'cli-passthrough': {
        const cliCmd = route.args ? `${route.cliCommand} ${route.args}` : route.cliCommand;
        const fullDisplay = `${currentEngineType} ${cliCmd}`;
        const loadingId = 'cmd-' + Date.now();
        const loadingMessage: Message = {
          id: loadingId,
          session_id: sessionId,
          role: 'assistant',
          content: `\`\`\`\n$ ${fullDisplay}\n\n${t('chat.terminalRunning')}\n\`\`\``,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, loadingMessage]);

        try {
          const res = await fetch('/api/chat/cli-exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              engine_type: currentEngineType,
              cli_command: cliCmd,
              cwd: workingDirectory,
              session_id: sessionId,
            }),
          });
          const data = await res.json() as { output?: string; exit_code?: number; error?: string };
          const output = data.output || data.error || t('chat.terminalNoOutput');
          const exitLabel = typeof data.exit_code === 'number' && data.exit_code !== 0
            ? `\n\n[exit ${data.exit_code}]`
            : '';
          setMessages(prev => prev.map(m =>
            m.id === loadingId
              ? { ...m, content: `\`\`\`\n$ ${fullDisplay}\n\n${output}${exitLabel}\n\`\`\`` }
              : m
          ));
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : 'Unknown error';
          setMessages(prev => prev.map(m =>
            m.id === loadingId
              ? { ...m, content: `\`\`\`\n$ ${fullDisplay}\n\n${t('chat.terminalError')}: ${errMsg}\n\`\`\`` }
              : m
          ));
        }
        return;
      }

      case 'prompt': {
        sendMessage(command);
        return;
      }

      case 'cli-only': {
        const localCtx: LocalCommandContext = {
          sessionId,
          engineType: currentEngineType,
          messages,
          currentModel,
          currentProviderId,
          currentReasoningEffort,
          currentApprovalPolicy,
          mode,
          workingDirectory,
          runtimeCommands,
          t,
        };
        const cliResult = handleCliOnlyCommand(route.commandName, localCtx);
        if (cliResult.message) appendAssistantMessage(cliResult.message);
        if (cliResult.actions) executeLocalActions(cliResult.actions);
        return;
      }

      case 'unknown': {
        handleUnknownCommand(command);
        return;
      }
    }
  }, [
    sessionId,
    sendMessage,
    currentEngineType,
    currentModel,
    currentProviderId,
    currentReasoningEffort,
    currentApprovalPolicy,
    workingDirectory,
    isStreaming,
    mode,
    messages,
    runtimeCommands,
    t,
    dispatchNativeManagedCommand,
    handleModeChange,
    appendAssistantMessage,
    executeLocalActions,
    handleUnknownCommand,
    router,
    setPanelOpen,
    setSessionId,
    setWorkingDirectory,
    preferenceTarget,
  ]);



  // Listen for command-rerun events from interactive CommandSelectBlock pickers.
  // When a user selects an option (e.g. model, permission mode), the block dispatches
  // a 'command-rerun' event. We route it through handleCommand for proper execution.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { command?: string } | undefined;
      if (detail?.command) {
        handleCommand(detail.command);
      }
    };
    window.addEventListener('command-rerun', handler);
    return () => window.removeEventListener('command-rerun', handler);
  }, [handleCommand]);

  // Listen for image generation completion — persist notice to DB and queue for next user message.
  // The notice is NOT sent as a separate LLM turn (avoids permission popups).
  // Instead it's flushed into the next user message via pendingImageNoticesRef.
  // MessageItem hides messages matching this prefix so the user doesn't see them.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const paths = (detail.images || [])
        .map((img: { localPath?: string }) => img.localPath)
        .filter(Boolean);
      const pathInfo = paths.length > 0 ? `\nGenerated image file paths:\n${paths.map((p: string) => `- ${p}`).join('\n')}` : '';
      const notice = `[Image generation completed]\n- Prompt: "${detail.prompt}"\n- Aspect ratio: ${detail.aspectRatio}\n- Resolution: ${detail.resolution}${pathInfo}`;

      // Store generated image paths so subsequent edits can use them as reference
      if (paths.length > 0) {
        setLastGeneratedImages(paths);
      }

      // Queue for next user message so the LLM gets the context
      pendingImageNoticesRef.current.push(notice);

      // Also persist to DB for history reload
      const dbNotice = `[__IMAGE_GEN_NOTICE__ prompt: "${detail.prompt}", aspect ratio: ${detail.aspectRatio}, resolution: ${detail.resolution}${paths.length > 0 ? `, file path: ${paths.join(', ')}` : ''}]`;
      fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, role: 'user', content: dbNotice }),
      }).catch(() => {});
    };
    window.addEventListener('image-gen-completed', handler);
    return () => window.removeEventListener('image-gen-completed', handler);
  }, [sessionId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessageList
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        toolUses={toolUses}
        toolResults={toolResults}
        streamingToolOutput={streamingToolOutput}
        statusText={statusText}
        pendingPermission={pendingPermission}
        onPermissionResponse={handlePermissionResponse}
        permissionResolved={permissionResolved}
        onForceStop={stopStreaming}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={loadEarlierMessages}
        engineType={currentEngineType}
        sessionId={sessionId}
      />
      {/* Batch image generation panels — shown above the input area */}
      <BatchExecutionDashboard />
      <BatchContextSync />

      <MessageInput
        onSend={sendMessage}
        onCommand={handleCommand}
        onUnknownCommand={handleUnknownCommand}
        onStop={stopStreaming}
        disabled={false}
        isStreaming={isStreaming}
        sessionId={sessionId}
        modelName={currentModel}
        onModelChange={setCurrentModel}
        providerId={currentProviderId}
        onProviderModelChange={handleProviderModelChange}
        engineType={currentEngineType}
        onEngineChange={handleEngineTypeChange}
        reasoningEffort={currentReasoningEffort}
        onReasoningEffortChange={handleReasoningEffortChange}
        workingDirectory={workingDirectory}
        mode={mode}
        onModeChange={handleModeChange}
        approvalPolicy={currentApprovalPolicy}
        onApprovalPolicyChange={setCurrentApprovalPolicy}
        runtimeCommands={runtimeCommands}
        nativeCommandNames={nativeCommandNames}
      />
    </div>
  );
}
