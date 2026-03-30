'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { FileAttachment, Message, SessionResponse, RemoteConnection } from '@/types';
import { MessageList } from '@/components/chat/MessageList';
import { MessageInput } from '@/components/chat/MessageInput';
import { usePanel } from '@/hooks/usePanel';
import { useTranslation } from '@/hooks/useTranslation';
import { useRuntimeCommands } from '@/hooks/useRuntimeCommands';
import { useNativeCommandController } from '@/hooks/useNativeCommandController';
import { startStream, stopStream } from '@/lib/stream-session-manager';
import { useDefaultModel, useDefaultReasoningEffort } from '@/hooks/useCliDefaults';
import {
  normalizeEngineType,
  normalizeReasoningEffort,
} from '@/lib/engine-defaults';
import {
  buildEnginePreferenceTarget,
  persistEnginePreferences,
  readActiveEngine,
  readEnginePreferences,
  type EnginePreferenceTarget,
} from '@/lib/engine-preferences';
import { buildInteractiveContent } from '@/lib/command-select-builder';
import { routeCommand } from '@/lib/command-dispatcher';
import { handleLocalCommand, handleCliOnlyCommand, type LocalCommandContext, type LocalCommandAction } from '@/lib/local-command-handlers';

export default function NewChatPage() {
  const router = useRouter();
  const {
    workingDirectory: panelWorkingDirectory,
    setWorkingDirectory,
    setSessionId,
    setPanelOpen,
    setStreamingSessionId,
    setPendingApprovalSessionId,
    workspaceMode,
    setRemoteConnectionId,
  } = usePanel();
  const { t } = useTranslation();
  const initialEngineType = 'claude';
  const cliDefaultModel = useDefaultModel(initialEngineType);
  const cliDefaultReasoning = useDefaultReasoningEffort(initialEngineType);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [pendingStreamSessionId, setPendingStreamSessionId] = useState('');
  const [workingDir, setWorkingDir] = useState(panelWorkingDirectory || '');
  const [remoteConnections, setRemoteConnections] = useState<RemoteConnection[]>([]);
  const [selectedRemoteConnectionId, setSelectedRemoteConnectionId] = useState('');
  const [remotePath, setRemotePath] = useState('');

  const [mode, setMode] = useState('code');
  const [currentEngineType, setCurrentEngineType] = useState(initialEngineType);
  const [currentModel, setCurrentModel] = useState(cliDefaultModel);
  const [currentProviderId, setCurrentProviderId] = useState('');
  const [currentReasoningEffort, setCurrentReasoningEffort] = useState<string>(
    normalizeReasoningEffort('') || cliDefaultReasoning
  );
  const preferenceTarget = useMemo(
    () => buildEnginePreferenceTarget(workspaceMode, selectedRemoteConnectionId),
    [selectedRemoteConnectionId, workspaceMode],
  );
  const runtimeCommands = useRuntimeCommands(currentEngineType);
  const nativeCommandContext = useMemo(() => ({
    mode,
    model: currentModel,
    provider_id: currentProviderId,
    reasoning_effort: currentReasoningEffort,
    working_directory: workspaceMode === 'local' ? workingDir.trim() : '',
  }), [mode, currentModel, currentProviderId, currentReasoningEffort, workingDir, workspaceMode]);
  const { nativeCommandNames, dispatchNativeManagedCommand } = useNativeCommandController({
    engineType: currentEngineType,
    context: nativeCommandContext,
  });

  const syncScopedEngineState = useCallback((target: EnginePreferenceTarget) => {
    const storedEngine = readActiveEngine(target);
    const storedPreferences = readEnginePreferences(storedEngine, target, { model: cliDefaultModel, reasoningEffort: cliDefaultReasoning });
    setCurrentEngineType(storedEngine);
    setCurrentModel(storedPreferences.model);
    setCurrentProviderId(storedPreferences.providerId);
    setCurrentReasoningEffort(storedEngine === 'codex' ? storedPreferences.reasoningEffort : '');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const storedWorkingDir = localStorage.getItem('codepilot:last-working-directory') || '';
    const storedRemoteConnectionId = localStorage.getItem('codepilot:last-remote-connection-id') || '';
    const storedRemotePath = localStorage.getItem('codepilot:last-remote-path') || '';

    setWorkingDir(panelWorkingDirectory || storedWorkingDir);
    setSelectedRemoteConnectionId(storedRemoteConnectionId);
    setRemotePath(storedRemotePath);
  }, [panelWorkingDirectory]);

  useEffect(() => {
    syncScopedEngineState(preferenceTarget);
  }, [preferenceTarget, syncScopedEngineState]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/remote/connections')
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        const nextConnections = Array.isArray(data.connections) ? data.connections as RemoteConnection[] : [];
        setRemoteConnections(nextConnections);
        setSelectedRemoteConnectionId((current) => {
          if (current && nextConnections.some((connection) => connection.id === current)) {
            return current;
          }
          return nextConnections[0]?.id || '';
        });
      })
      .catch(() => {
        if (!cancelled) setRemoteConnections([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const appendAssistantMessage = useCallback((content: string) => {
    const message: Message = {
      id: 'cmd-' + Date.now(),
      session_id: '',
      role: 'assistant',
      content,
      created_at: new Date().toISOString(),
      token_usage: null,
    };
    setMessages((prev) => [...prev, message]);
  }, []);

  const handleReasoningEffortChange = useCallback((nextReasoningEffort: string) => {
    const nextValue = normalizeReasoningEffort(nextReasoningEffort)
      || readEnginePreferences('codex', preferenceTarget, { model: cliDefaultModel, reasoningEffort: cliDefaultReasoning }).reasoningEffort;
    setCurrentReasoningEffort(nextValue);
    persistEnginePreferences('codex', { reasoningEffort: nextValue }, preferenceTarget);
  }, [preferenceTarget]);

  const handleProviderModelChange = useCallback((providerId: string, model: string) => {
    setCurrentProviderId(providerId);
    setCurrentModel(model);
    persistEnginePreferences(currentEngineType, { providerId, model }, preferenceTarget);
    window.dispatchEvent(new Event('engine-changed'));
  }, [currentEngineType, preferenceTarget]);

  const handleEngineTypeChange = useCallback((nextEngineType: string) => {
    const normalizedEngine = normalizeEngineType(nextEngineType);
    persistEnginePreferences(currentEngineType, {
      model: currentModel,
      providerId: currentProviderId,
      reasoningEffort: currentReasoningEffort,
    }, preferenceTarget);
    const nextPreferences = readEnginePreferences(normalizedEngine, preferenceTarget, { model: cliDefaultModel, reasoningEffort: cliDefaultReasoning });

    setCurrentEngineType(normalizedEngine);
    setCurrentModel(nextPreferences.model);
    setCurrentProviderId(nextPreferences.providerId);
    setCurrentReasoningEffort(normalizedEngine === 'codex' ? nextPreferences.reasoningEffort : '');
    persistEnginePreferences(normalizedEngine, {
      model: nextPreferences.model,
      providerId: nextPreferences.providerId,
      reasoningEffort: normalizedEngine === 'codex' ? nextPreferences.reasoningEffort : '',
    }, preferenceTarget);
    window.dispatchEvent(new Event('engine-changed'));
  }, [currentEngineType, currentModel, currentProviderId, currentReasoningEffort, preferenceTarget]);

  const sendFirstMessage = useCallback(
    async (content: string, files?: FileAttachment[], systemPromptAppend?: string) => {
      if (isStarting) return;

      const trimmedWorkingDir = workingDir.trim();
      const trimmedRemotePath = remotePath.trim();
      if (workspaceMode === 'local' && !trimmedWorkingDir) {
        appendAssistantMessage(`**${t('chat.selectProjectFirstTitle')}** ${t('chat.selectProjectFirstDesc')}`);
        return;
      }
      if (workspaceMode === 'remote' && !selectedRemoteConnectionId) {
        appendAssistantMessage(`**${t('chat.remoteConnection')}** ${t('chat.remoteConnectionRequired')}`);
        return;
      }
      if (workspaceMode === 'remote' && !trimmedRemotePath) {
        appendAssistantMessage(`**${t('chat.remotePath')}** ${t('chat.remotePathRequired')}`);
        return;
      }

      setIsStarting(true);

      try {
        const createBody: Record<string, string> = {
          title: content.slice(0, 50),
          mode,
          engine_type: currentEngineType,
          model: currentModel,
          provider_id: currentProviderId,
          reasoning_effort: currentEngineType === 'codex' ? currentReasoningEffort : '',
          workspace_transport: workspaceMode === 'remote' ? 'ssh_direct' : 'local',
        };
        if (workspaceMode === 'remote') {
          createBody.remote_connection_id = selectedRemoteConnectionId;
          createBody.remote_path = trimmedRemotePath;
        } else {
          createBody.working_directory = trimmedWorkingDir;
        }

        const createRes = await fetch('/api/chat/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createBody),
        });

        if (!createRes.ok) {
          const errBody = await createRes.json().catch(() => ({}));
          throw new Error(errBody.error || `Failed to create session (${createRes.status})`);
        }

        const { session }: SessionResponse = await createRes.json();
        const resolvedWorkingDirectory = session.working_directory || trimmedWorkingDir;
        setPendingStreamSessionId(session.id);
        setWorkingDirectory(resolvedWorkingDirectory);
        setSessionId(session.id);
        setPanelOpen(true);
        setStreamingSessionId(session.id);
        setPendingApprovalSessionId('');
        setRemoteConnectionId(workspaceMode === 'remote' ? selectedRemoteConnectionId : '');
        localStorage.setItem('codepilot:last-working-directory', resolvedWorkingDirectory);
        if (workspaceMode === 'remote') {
          localStorage.setItem('codepilot:last-remote-connection-id', selectedRemoteConnectionId);
          localStorage.setItem('codepilot:last-remote-path', trimmedRemotePath);
        }

        window.dispatchEvent(new CustomEvent('session-created'));
        window.dispatchEvent(new Event('refresh-file-tree'));

        let displayContent = content;
        if (files && files.length > 0) {
          const fileMeta = files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size }));
          displayContent = `<!--files:${JSON.stringify(fileMeta)}-->${content}`;
        }
        const userMessage: Message = {
          id: 'temp-' + Date.now(),
          session_id: session.id,
          role: 'user',
          content: displayContent,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages([userMessage]);

        startStream({
          sessionId: session.id,
          content,
          mode,
          model: currentModel,
          reasoningEffort: currentEngineType === 'codex' ? currentReasoningEffort : '',
          providerId: currentProviderId,
          engineType: currentEngineType,
          files,
          systemPromptAppend,
          onModeChanged: (sdkMode) => {
            setMode(sdkMode === 'plan' ? 'plan' : 'code');
          },
        });

        router.push(`/chat/${session.id}`);
      } catch (error) {
        setPendingStreamSessionId('');
        setStreamingSessionId('');
        setPendingApprovalSessionId('');
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        const errorMessage: Message = {
          id: 'temp-error-' + Date.now(),
          session_id: '',
          role: 'assistant',
          content: `**Error:** ${errMsg}`,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsStarting(false);
      }
    },
    [
      appendAssistantMessage,
      currentEngineType,
      currentModel,
      currentProviderId,
      currentReasoningEffort,
      isStarting,
      mode,
      remotePath,
      router,
      selectedRemoteConnectionId,
      setPanelOpen,
      setPendingApprovalSessionId,
      setRemoteConnectionId,
      setSessionId,
      setStreamingSessionId,
      setWorkingDirectory,
      t,
      workingDir,
      workspaceMode,
    ]
  );

  const handleUnknownCommand = useCallback((command: string) => {
    const unknownCommandMessage: Message = {
      id: 'cmd-' + Date.now(),
      session_id: '',
      role: 'assistant',
      content: `## ${t('chat.unknownCommandTitle')}\n\n${t('chat.unknownCommandDesc', { command })}\n\n${t('chat.unknownCommandHelp')}`,
      created_at: new Date().toISOString(),
      token_usage: null,
    };
    setMessages(prev => [...prev, unknownCommandMessage]);
  }, [t]);

  const executeLocalActions = useCallback((actions: LocalCommandAction[]) => {
    for (const action of actions) {
      switch (action.type) {
        case 'clearMessages':
          setMessages([]);
          break;
        case 'navigate':
          router.push(action.path);
          break;
        case 'openPanel':
          setPanelOpen(true);
          break;
        case 'switchMode':
          setMode(action.mode);
          break;
        case 'openExternal':
          window.open(action.url, '_blank');
          break;
        case 'copyLastResponse':
          appendAssistantMessage(t('chat.nothingToCopy'));
          break;
        case 'openFolderPicker':
          appendAssistantMessage(t('chat.electronOnlyFeature'));
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
              const interactiveContent = buildInteractiveContent('model', data, '', currentEngineType, currentModel);
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
      }
    }
  }, [router, setPanelOpen, appendAssistantMessage, t, currentEngineType, currentModel]);

  const handleCommand = useCallback(async (command: string) => {
    const route = routeCommand(command, currentEngineType, runtimeCommands);

    switch (route.layer) {
      case 'stream': {
        // No active session on new chat page — stream commands require a session
        appendAssistantMessage(`\`/${route.commandName}\` requires an active conversation.`);
        return;
      }

      case 'native': {
        const nativeDispatch = await dispatchNativeManagedCommand(command);

        if (nativeDispatch.matched && nativeDispatch.handled) {
          if (nativeDispatch.statePatch) {
            const statePatch = nativeDispatch.statePatch;
            if (statePatch.model && statePatch.model !== currentModel) {
              setCurrentModel(statePatch.model);
              persistEnginePreferences(currentEngineType, {
                model: statePatch.model,
                providerId: currentProviderId,
                reasoningEffort: currentReasoningEffort,
              }, preferenceTarget);
            }
            if (statePatch.provider_id && statePatch.provider_id !== currentProviderId) {
              setCurrentProviderId(statePatch.provider_id);
              persistEnginePreferences(currentEngineType, {
                model: statePatch.model || currentModel,
                providerId: statePatch.provider_id,
                reasoningEffort: currentReasoningEffort,
              }, preferenceTarget);
            }
            if (statePatch.reasoning_effort && statePatch.reasoning_effort !== currentReasoningEffort) {
              setCurrentReasoningEffort(statePatch.reasoning_effort);
              persistEnginePreferences(currentEngineType, {
                model: statePatch.model || currentModel,
                providerId: statePatch.provider_id || currentProviderId,
                reasoningEffort: statePatch.reasoning_effort,
              }, preferenceTarget);
            }
            if (statePatch.mode && statePatch.mode !== mode) {
              setMode(statePatch.mode);
            }
          }

          // When invoked without args, check if we can show an interactive picker
          if (!route.args && nativeDispatch.data) {
            const interactiveContent = buildInteractiveContent(
              route.commandName, nativeDispatch.data, '', currentEngineType, currentModel,
            );
            if (interactiveContent) {
              appendAssistantMessage(interactiveContent);
              return;
            }
          }

          appendAssistantMessage(nativeDispatch.message);
          return;
        }
        if (nativeDispatch.matched && !nativeDispatch.handled) {
          appendAssistantMessage(nativeDispatch.message);
          return;
        }
        if (nativeDispatch.message) {
          appendAssistantMessage(nativeDispatch.message);
        }
        return;
      }

      case 'local': {
        const workingDirectory = workspaceMode === 'remote'
          ? remotePath.trim()
          : workingDir.trim();
        const localCtx: LocalCommandContext = {
          sessionId: '',
          engineType: currentEngineType,
          messages,
          currentModel,
          currentProviderId,
          currentReasoningEffort,
          currentApprovalPolicy: 'suggest',
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
          session_id: '',
          role: 'assistant',
          content: `\`\`\`\n$ ${fullDisplay}\n\n${t('chat.terminalRunning')}\n\`\`\``,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, loadingMessage]);

        const cwdForExec = workspaceMode === 'remote' ? undefined : workingDir;
        const connectionForExec = workspaceMode === 'remote' ? selectedRemoteConnectionId : undefined;
        const remoteCwdForExec = workspaceMode === 'remote' ? remotePath : undefined;

        try {
          const res = await fetch('/api/chat/cli-exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              engine_type: currentEngineType,
              cli_command: cliCmd,
              cwd: cwdForExec,
              connection_id: connectionForExec,
              remote_cwd: remoteCwdForExec,
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
        sendFirstMessage(command);
        return;
      }

      case 'cli-only': {
        const workingDirectory = workspaceMode === 'remote'
          ? remotePath.trim()
          : workingDir.trim();
        const localCtx: LocalCommandContext = {
          sessionId: '',
          engineType: currentEngineType,
          messages,
          currentModel,
          currentProviderId,
          currentReasoningEffort,
          currentApprovalPolicy: 'suggest',
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
    appendAssistantMessage,
    currentEngineType,
    currentModel,
    currentProviderId,
    currentReasoningEffort,
    dispatchNativeManagedCommand,
    executeLocalActions,
    handleUnknownCommand,
    messages,
    mode,
    preferenceTarget,
    remotePath,
    router,
    runtimeCommands,
    selectedRemoteConnectionId,
    sendFirstMessage,
    setPanelOpen,
    t,
    workingDir,
    workspaceMode,
  ]);



  const handleStop = useCallback(() => {
    if (!pendingStreamSessionId) return;
    stopStream(pendingStreamSessionId);
    setPendingApprovalSessionId('');
  }, [pendingStreamSessionId, setPendingApprovalSessionId]);

  // Listen for command-rerun events from interactive CommandSelectBlock pickers.
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

  const showSetupLanding = workspaceMode === 'remote' || !pendingStreamSessionId;

  if (showSetupLanding) {
    const workspacePathLabel = workspaceMode === 'remote'
      ? t('chat.remotePath')
      : t('chat.statusProject');
    const workspacePathValue = workspaceMode === 'remote'
      ? remotePath.trim()
      : workingDir.trim();

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
          {workspaceMode === 'remote' && (
            <div className="w-full max-w-sm space-y-2">
              <p className="text-xs text-muted-foreground">{t('chat.remoteConnection')}</p>
              <Select
                value={selectedRemoteConnectionId}
                onValueChange={(value) => {
                  setSelectedRemoteConnectionId(value);
                  localStorage.setItem('codepilot:last-remote-connection-id', value);
                  window.dispatchEvent(new Event('remote-connection-changed'));
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('chat.remoteConnection')} />
                </SelectTrigger>
                <SelectContent>
                  {remoteConnections.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.name} ({connection.username ? `${connection.username}@` : ''}{connection.host})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="w-full max-w-sm space-y-2">
            <p className="text-xs text-muted-foreground">{t('chat.statusRuntime')}</p>
            <Select value={currentEngineType} onValueChange={handleEngineTypeChange}>
              <SelectTrigger>
                <SelectValue placeholder={t('chat.statusRuntime')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">{t('chatList.providerClaude')}</SelectItem>
                <SelectItem value="codex">{t('chatList.providerCodex')}</SelectItem>
                <SelectItem value="gemini">{t('chatList.providerGemini')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-full max-w-sm space-y-2">
            <p className="text-xs text-muted-foreground">{workspacePathLabel}</p>
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-foreground/80">
              {workspacePathValue || t('chat.selectProjectFirstTitle')}
            </div>
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">
              {workspaceMode === 'remote'
                ? t('chat.remoteSelectFolderHint')
                : t('chat.localSelectFolderHint')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessageList
        messages={messages}
        streamingContent=""
        isStreaming={Boolean(pendingStreamSessionId)}
        toolUses={[]}
        toolResults={[]}
        streamingToolOutput=""
        statusText={undefined}
        pendingPermission={null}
        onPermissionResponse={undefined}
        permissionResolved={null}
        engineType={currentEngineType}
        sessionId={pendingStreamSessionId || undefined}
      />
      <MessageInput
        onSend={sendFirstMessage}
        onCommand={handleCommand}
        onUnknownCommand={handleUnknownCommand}
        onStop={handleStop}
        disabled={isStarting && !pendingStreamSessionId}
        isStreaming={Boolean(pendingStreamSessionId)}
        modelName={currentModel}
        onModelChange={setCurrentModel}
        providerId={currentProviderId}
        onProviderModelChange={handleProviderModelChange}
        engineType={currentEngineType}
        onEngineChange={handleEngineTypeChange}
        reasoningEffort={currentReasoningEffort}
        onReasoningEffortChange={handleReasoningEffortChange}
        workingDirectory={workingDir}
        mode={mode}
        onModeChange={setMode}
        runtimeCommands={runtimeCommands}
        nativeCommandNames={nativeCommandNames}
      />
    </div>
  );
}
