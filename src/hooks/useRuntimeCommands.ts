'use client';

import { useEffect, useState } from 'react';
import { normalizeEngineType } from '@/lib/engine-defaults';
import type { RuntimeCommandMetadata } from '@/lib/runtime-command-catalog';

export function useRuntimeCommands(engineType: string): RuntimeCommandMetadata[] {
  const normalizedEngineType = normalizeEngineType(engineType);
  const [commands, setCommands] = useState<RuntimeCommandMetadata[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadCommands = async () => {
      try {
        const response = await fetch(`/api/runtime-commands?engine_type=${normalizedEngineType}`);
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        setCommands(Array.isArray(data.commands) ? data.commands : []);
        setLoaded(true);
      } catch {
        if (!cancelled) {
          setCommands([]);
        }
      }
    };

    void loadCommands();

    return () => {
      cancelled = true;
    };
  }, [normalizedEngineType]);

  return commands;
}
