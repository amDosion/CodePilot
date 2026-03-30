'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { normalizeEngineType } from '@/lib/engine-defaults';
import type {
  NativeCommandControllerRequest,
  NativeCommandControllerRequestContext,
  NativeCommandControllerResponse,
  NativeCommandStatePatch,
} from '@/types';

/**
 * Hardcoded fallback: used only while the API fetch is in flight or if
 * the fetch fails. These MUST stay in sync with fallbacks.ts and the
 * native controllers. They are the last-resort safety net.
 */
const NATIVE_COMMANDS_FALLBACK: Record<string, readonly string[]> = {
  claude: ['model', 'permissions', 'status', 'mcp', 'doctor', 'memory', 'agents', 'pr_comments', 'diff'],
  codex: ['model', 'status', 'mcp', 'fork', 'permissions', 'diff', 'agent', 'experimental', 'personality', 'ps', 'debug-config', 'skills', 'apps'],
  gemini: ['about', 'mcp', 'permissions', 'settings', 'auth', 'memory', 'agents', 'extensions', 'hooks', 'skills', 'tools', 'doctor', 'diff', 'model', 'init'],
};

export interface NativeCommandInvocationResult {
  handled: boolean;
  unavailable: boolean;
  commandName: string;
  canonical: string;
  args: string;
  message?: string;
  statePatch?: NativeCommandStatePatch;
  data?: unknown;
  error?: string;
}

export interface NativeCommandDispatchResult {
  matched: boolean;
  handled: boolean;
  unavailable: boolean;
  commandName: string;
  canonical: string;
  args: string;
  message: string;
  statePatch?: NativeCommandStatePatch;
  data?: unknown;
  error?: string;
}

export interface UseNativeCommandControllerOptions {
  sessionId?: string;
  engineType: string;
  context?: NativeCommandControllerRequestContext;
  endpoint?: string;
}

export function parseSlashCommand(rawCommand: string): {
  commandName: string;
  args: string;
  canonical: string;
} {
  const trimmed = rawCommand.trim();
  if (!trimmed.startsWith('/')) {
    return { commandName: '', args: '', canonical: '' };
  }

  const [head, ...rest] = trimmed.split(/\s+/);
  const commandName = head.replace(/^\//, '').toLowerCase();
  const args = rest.join(' ').trim();
  const canonical = commandName ? `/${commandName}` : '';
  return { commandName, args, canonical };
}

/**
 * Fetch native command names from the dynamic command registry API.
 * Falls back to the hardcoded list on error.
 */
function useDynamicNativeCommandNames(engineType: string): string[] {
  const normalizedEngine = normalizeEngineType(engineType);
  const fallback = NATIVE_COMMANDS_FALLBACK[normalizedEngine] ?? [];
  const [names, setNames] = useState<string[]>([...fallback]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/runtime-commands?engine_type=${normalizedEngine}`);
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (cancelled || !Array.isArray(data.commands)) return;

        // Extract names of "official" commands (i.e. native, not codepilot)
        const officialNames = (data.commands as Array<{ name: string; source?: string }>)
          .filter((cmd) => cmd.source === 'official')
          .map((cmd) => cmd.name);

        if (officialNames.length > 0) {
          setNames(officialNames);
        }
      } catch {
        // Keep fallback on network error
      }
    };

    void load();

    return () => { cancelled = true; };
  }, [normalizedEngine]);

  return names;
}

export function useNativeCommandController(options: UseNativeCommandControllerOptions) {
  const normalizedEngineType = normalizeEngineType(options.engineType);
  const endpoint = options.endpoint || '/api/chat/native-command';

  const nativeCommandNames = useDynamicNativeCommandNames(normalizedEngineType);

  const nativeCommandNameSet = useMemo<Set<string>>(
    () => new Set<string>(nativeCommandNames),
    [nativeCommandNames]
  );

  const isNativeManagedCommand = useCallback((rawCommand: string) => {
    const parsed = parseSlashCommand(rawCommand);
    return nativeCommandNameSet.has(parsed.commandName);
  }, [nativeCommandNameSet]);

  const invokeNativeCommand = useCallback(async (rawCommand: string): Promise<NativeCommandInvocationResult> => {
    const parsed = parseSlashCommand(rawCommand);
    if (!parsed.commandName || !nativeCommandNameSet.has(parsed.commandName)) {
      return {
        handled: false,
        unavailable: false,
        commandName: parsed.commandName,
        canonical: parsed.canonical,
        args: parsed.args,
      };
    }

    const requestBody: NativeCommandControllerRequest = {
      session_id: options.sessionId,
      engine_type: normalizedEngineType,
      command: rawCommand,
      command_name: parsed.commandName,
      args: parsed.args || undefined,
      context: options.context,
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const body = await res.json().catch(() => ({})) as Partial<NativeCommandControllerResponse>;
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        return {
          handled: false,
          unavailable: true,
          commandName: parsed.commandName,
          canonical: parsed.canonical,
          args: parsed.args,
          message: typeof body.message === 'string' ? body.message : undefined,
          error: typeof body.error === 'string' ? body.error : undefined,
        };
      }

      if (!res.ok) {
        return {
          handled: false,
          unavailable: false,
          commandName: parsed.commandName,
          canonical: parsed.canonical,
          args: parsed.args,
          message: typeof body.message === 'string' ? body.message : undefined,
          error: typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
        };
      }

      return {
        handled: Boolean(body.handled),
        unavailable: false,
        commandName: parsed.commandName,
        canonical: parsed.canonical,
        args: parsed.args,
        message: typeof body.message === 'string' ? body.message : undefined,
        statePatch: body.state_patch,
        data: body.data,
        error: typeof body.error === 'string' ? body.error : undefined,
      };
    } catch (error) {
      return {
        handled: false,
        unavailable: true,
        commandName: parsed.commandName,
        canonical: parsed.canonical,
        args: parsed.args,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [endpoint, nativeCommandNameSet, normalizedEngineType, options.context, options.sessionId]);

  const dispatchNativeManagedCommand = useCallback(async (rawCommand: string): Promise<NativeCommandDispatchResult> => {
    const parsed = parseSlashCommand(rawCommand);
    const canonical = parsed.canonical || (parsed.commandName ? `/${parsed.commandName}` : rawCommand.trim());
    if (!parsed.commandName || !nativeCommandNameSet.has(parsed.commandName)) {
      return {
        matched: false,
        handled: false,
        unavailable: false,
        commandName: parsed.commandName,
        canonical,
        args: parsed.args,
        message: '',
      };
    }

    const result = await invokeNativeCommand(rawCommand);
    const message = result.message?.trim()
      || (result.handled
        ? `Executed \`${canonical}\`.`
        : result.unavailable
          ? `Native command controller unavailable for \`${canonical}\`.`
          : result.error
            ? `Native command \`${canonical}\` failed: ${result.error}.`
            : `Native command \`${canonical}\` was not handled by backend.`);

    return {
      matched: true,
      handled: result.handled,
      unavailable: result.unavailable,
      commandName: result.commandName,
      canonical: result.canonical || canonical,
      args: result.args,
      message,
      statePatch: result.statePatch,
      data: result.data,
      error: result.error,
    };
  }, [invokeNativeCommand, nativeCommandNameSet]);

  return {
    nativeCommandNames,
    isNativeManagedCommand,
    invokeNativeCommand,
    dispatchNativeManagedCommand,
  };
}
