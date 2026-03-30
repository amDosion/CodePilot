'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { normalizeEngineType } from '@/lib/engine-defaults';

interface CliDefaults {
  model: string | null;
  reasoningEffort: string | null;
  permissionMode: string | null;
}

type CliDefaultsMap = Record<string, CliDefaults>;

const CliDefaultsContext = createContext<CliDefaultsMap>({});

const EMPTY: CliDefaults = { model: null, reasoningEffort: null, permissionMode: null };

/**
 * Fetch CLI config file defaults for an engine.
 * Results are cached in-memory for the session lifetime.
 */
const cache: CliDefaultsMap = {};

async function fetchCliDefaults(engine: string): Promise<CliDefaults> {
  const key = normalizeEngineType(engine);
  if (cache[key]) return cache[key];
  try {
    const res = await fetch(`/api/cli-defaults?engine_type=${key}`);
    if (!res.ok) return EMPTY;
    const data = await res.json();
    const defaults: CliDefaults = {
      model: data.model || null,
      reasoningEffort: data.reasoningEffort || null,
      permissionMode: data.permissionMode || null,
    };
    cache[key] = defaults;
    return defaults;
  } catch {
    return EMPTY;
  }
}

export function CliDefaultsProvider({ children }: { children: ReactNode }) {
  const [defaults, setDefaults] = useState<CliDefaultsMap>({});

  useEffect(() => {
    // Preload defaults for all engines
    Promise.all([
      fetchCliDefaults('claude'),
      fetchCliDefaults('codex'),
      fetchCliDefaults('gemini'),
    ]).then(([claude, codex, gemini]) => {
      setDefaults({ claude, codex, gemini });
    });
  }, []);

  return (
    <CliDefaultsContext.Provider value={defaults}>
      {children}
    </CliDefaultsContext.Provider>
  );
}

export function useCliDefaults(engine?: string | null): CliDefaults {
  const defaults = useContext(CliDefaultsContext);
  const key = normalizeEngineType(engine);
  return defaults[key] || EMPTY;
}

/**
 * Get CLI-configured default model, with hardcoded fallback.
 * Use this instead of getDefaultModelForEngine() in client components.
 */
export function useDefaultModel(engine?: string | null): string {
  const cli = useCliDefaults(engine);
  if (cli.model) return cli.model;
  // Hardcoded fallback only when CLI has no config
  const key = normalizeEngineType(engine);
  if (key === 'codex') return 'gpt-5.3-codex';
  if (key === 'gemini') return 'auto-gemini-2.5';
  return 'sonnet';
}

export function useDefaultReasoningEffort(engine?: string | null): string {
  const cli = useCliDefaults(engine);
  if (cli.reasoningEffort) return cli.reasoningEffort;
  const key = normalizeEngineType(engine);
  if (key === 'codex') return 'medium';
  if (key === 'claude') return 'high';
  return '';
}

export function useDefaultProviderId(engine?: string | null): string {
  const key = normalizeEngineType(engine);
  return (key === 'codex' || key === 'gemini') ? 'env' : '';
}
