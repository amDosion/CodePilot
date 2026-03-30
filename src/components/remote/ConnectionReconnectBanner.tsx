'use client';

import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { usePanel } from '@/hooks/usePanel';

interface ConnectionReconnectBannerProps {
  connectionId: string;
}

export function ConnectionReconnectBanner({ connectionId }: ConnectionReconnectBannerProps) {
  const [loading, setLoading] = useState(false);
  const { t } = useTranslation();
  const { remoteConnectionId, remoteConnectionReady, remoteConnectionState } = usePanel();

  if (!connectionId || connectionId !== remoteConnectionId) {
    return null;
  }

  const status = remoteConnectionReady
    ? 'connected'
    : remoteConnectionState === 'ready'
      ? 'connected'
      : remoteConnectionState;

  if (!status || status === 'connected' || status === 'checking') {
    return null;
  }

  const isReconnecting = status === 'reconnecting';

  const handleReconnect = async () => {
    setLoading(true);
    try {
      await fetch(`/api/remote/connections/${connectionId}/health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reconnect' }),
      });
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={
      isReconnecting
        ? 'flex items-center justify-center gap-3 border-b border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-xs text-yellow-700 dark:text-yellow-300'
        : 'flex items-center justify-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive'
    }>
      <span className={`inline-block h-2 w-2 rounded-full ${isReconnecting ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}`} />
      <span>
        {isReconnecting ? t('remote.healthReconnecting') : t('remote.healthDisconnected')}
      </span>
      {!isReconnecting && (
        <button
          type="button"
          onClick={() => void handleReconnect()}
          disabled={loading}
          className="rounded border border-current/30 px-2 py-0.5 hover:bg-destructive/10 disabled:opacity-50"
        >
          {t('remote.reconnect')}
        </button>
      )}
    </div>
  );
}
