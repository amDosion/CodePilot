'use client';

import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { usePanel } from '@/hooks/usePanel';

interface ConnectionHealthIndicatorProps {
  connectionId: string;
  compact?: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  connected: 'bg-green-500',
  checking: 'bg-yellow-500 animate-pulse',
  reconnecting: 'bg-yellow-500 animate-pulse',
  connecting: 'bg-yellow-500 animate-pulse',
  disconnected: 'bg-red-500',
  error: 'bg-red-500',
};

export function ConnectionHealthIndicator({ connectionId, compact = false }: ConnectionHealthIndicatorProps) {
  const { t } = useTranslation();
  const { remoteConnectionId, remoteConnectionReady, remoteConnectionState } = usePanel();
  const [loading, setLoading] = useState(false);

  if (!connectionId || connectionId !== remoteConnectionId) {
    return null;
  }

  const status = remoteConnectionReady
    ? 'connected'
    : remoteConnectionState === 'ready'
      ? 'connected'
      : remoteConnectionState;
  const dotColor = STATUS_COLORS[status] || 'bg-gray-500';

  const handleCheck = async () => {
    setLoading(true);
    try {
      await fetch(`/api/remote/connections/${connectionId}/health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check' }),
      });
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const title = status === 'connected'
    ? t('remote.healthConnected')
    : status === 'reconnecting'
      ? t('remote.healthReconnecting')
      : status === 'checking'
        ? t('remote.healthChecking')
        : status === 'error'
          ? t('remote.healthError')
          : t('remote.healthDisconnected');

  if (compact) {
    return (
      <span
        className="inline-flex cursor-pointer items-center gap-1"
        title={title}
        onClick={() => void handleCheck()}
      >
        <span className={`inline-block h-2 w-2 rounded-full ${dotColor} ${loading ? 'opacity-70' : ''}`} />
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
      <span>{title}</span>
    </div>
  );
}
