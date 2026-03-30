"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/hooks/useTranslation";
import type { RemoteConnection, RemoteTunnel } from "@/types";

interface RemoteConnectionForm {
  name: string;
  host: string;
  port: string;
  username: string;
  auth_mode: 'agent' | 'key';
  private_key_path: string;
  remote_root: string;
}

const EMPTY_FORM: RemoteConnectionForm = {
  name: "",
  host: "",
  port: "22",
  username: "",
  auth_mode: "agent",
  private_key_path: "",
  remote_root: "",
};

export function RemoteDevSection() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<RemoteConnection[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<RemoteConnectionForm>(EMPTY_FORM);
  const [tunnels, setTunnels] = useState<RemoteTunnel[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [command, setCommand] = useState("pwd && uname -a");
  const [commandOutput, setCommandOutput] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [runningCommand, setRunningCommand] = useState(false);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelForm, setTunnelForm] = useState({ local_port: "9222", remote_host: "127.0.0.1", remote_port: "9222" });

  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.id === selectedId) || null,
    [connections, selectedId],
  );

  const applyConnectionToForm = useCallback((connection: RemoteConnection | null) => {
    if (!connection) {
      setForm(EMPTY_FORM);
      return;
    }
    setForm({
      name: connection.name,
      host: connection.host,
      port: String(connection.port || 22),
      username: connection.username || "",
      auth_mode: connection.auth_mode === "key" ? "key" : "agent",
      private_key_path: connection.private_key_path || "",
      remote_root: connection.remote_root || "",
    });
  }, []);

  const fetchConnections = useCallback(async () => {
    const response = await fetch('/api/remote/connections');
    const data = await response.json();
    const nextConnections = Array.isArray(data.connections) ? data.connections as RemoteConnection[] : [];
    setConnections(nextConnections);
    setSelectedId((current) => {
      if (current && nextConnections.some((connection) => connection.id === current)) {
        return current;
      }
      const nextId = nextConnections[0]?.id || "";
      applyConnectionToForm(nextConnections[0] || null);
      return nextId;
    });
  }, [applyConnectionToForm]);

  const fetchTunnels = useCallback(async () => {
    const response = await fetch('/api/remote/tunnels');
    const data = await response.json();
    setTunnels(Array.isArray(data.tunnels) ? data.tunnels as RemoteTunnel[] : []);
  }, []);

  useEffect(() => {
    fetchConnections().catch(() => {});
    fetchTunnels().catch(() => {});
  }, [fetchConnections, fetchTunnels]);

  useEffect(() => {
    applyConnectionToForm(selectedConnection);
  }, [selectedConnection, applyConnectionToForm]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatusMessage("");
    try {
      const payload = {
        ...form,
        port: Number(form.port || 22),
      };
      const response = await fetch(selectedId ? `/api/remote/connections/${selectedId}` : '/api/remote/connections', {
        method: selectedId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t('remoteDev.saveFailed'));
      }
      await fetchConnections();
      const nextId = data.connection?.id || selectedId;
      if (nextId) setSelectedId(nextId);
      setStatusMessage(t('remoteDev.saved'));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t('remoteDev.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [fetchConnections, form, selectedId, t]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    setStatusMessage("");
    const response = await fetch(`/api/remote/connections/${selectedId}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setStatusMessage(data.error || t('remoteDev.deleteFailed'));
      return;
    }
    setSelectedId("");
    setForm(EMPTY_FORM);
    await fetchConnections();
    setStatusMessage(t('remoteDev.deleted'));
  }, [fetchConnections, selectedId, t]);

  const handleTest = useCallback(async () => {
    if (!selectedId) return;
    setTesting(true);
    setStatusMessage("");
    try {
      const response = await fetch(`/api/remote/connections/${selectedId}/test`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t('remoteDev.testFailed'));
      }
      await fetchConnections();
      setStatusMessage(t('remoteDev.testSuccess', { path: data.remote_pwd || '' }));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t('remoteDev.testFailed'));
    } finally {
      setTesting(false);
    }
  }, [fetchConnections, selectedId, t]);


  const handleRunCommand = useCallback(async () => {
    if (!selectedId || !command.trim()) return;
    setRunningCommand(true);
    setCommandOutput("");
    try {
      const response = await fetch('/api/remote/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: selectedId, command }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t('remoteDev.commandFailed'));
      }
      setCommandOutput([data.stdout || '', data.stderr || ''].filter(Boolean).join('\n'));
    } catch (error) {
      setCommandOutput(error instanceof Error ? error.message : t('remoteDev.commandFailed'));
    } finally {
      setRunningCommand(false);
    }
  }, [command, selectedId, t]);

  const handleOpenTunnel = useCallback(async () => {
    if (!selectedId) return;
    setTunnelLoading(true);
    setStatusMessage("");
    try {
      const response = await fetch('/api/remote/tunnels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection_id: selectedId,
          local_port: Number(tunnelForm.local_port),
          remote_host: tunnelForm.remote_host,
          remote_port: Number(tunnelForm.remote_port),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t('remoteDev.tunnelOpenFailed'));
      }
      await fetchTunnels();
      setStatusMessage(t('remoteDev.tunnelOpened', { port: String(data.tunnel?.local_port || tunnelForm.local_port) }));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t('remoteDev.tunnelOpenFailed'));
    } finally {
      setTunnelLoading(false);
    }
  }, [fetchTunnels, selectedId, t, tunnelForm.local_port, tunnelForm.remote_host, tunnelForm.remote_port]);

  const handleCloseTunnel = useCallback(async (tunnelId: string) => {
    await fetch(`/api/remote/tunnels/${tunnelId}`, { method: 'DELETE' });
    await fetchTunnels();
  }, [fetchTunnels]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('remoteDev.title')}</CardTitle>
          <CardDescription>{t('remoteDev.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('remoteDev.connections')}</Label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSelectedId("");
                  setForm(EMPTY_FORM);
                  setStatusMessage("");
                }}
              >
                {t('remoteDev.newConnection')}
              </Button>
            </div>
            <div className="space-y-2 rounded-lg border p-2">
              {connections.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('remoteDev.noConnections')}</p>
              )}
              {connections.map((connection) => (
                <button
                  key={connection.id}
                  type="button"
                  onClick={() => setSelectedId(connection.id)}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm ${selectedId === connection.id ? 'border-foreground bg-accent' : 'border-transparent hover:border-border hover:bg-accent/50'}`}
                >
                  <div className="font-medium">{connection.name}</div>
                  <div className="text-xs text-muted-foreground">{connection.username ? `${connection.username}@` : ''}{connection.host}:{connection.port}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="remote-name">{t('remoteDev.name')}</Label>
                <Input id="remote-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="remote-host">{t('remoteDev.host')}</Label>
                <Input id="remote-host" value={form.host} onChange={(event) => setForm((current) => ({ ...current, host: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="remote-port">{t('remoteDev.port')}</Label>
                <Input id="remote-port" value={form.port} onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="remote-username">{t('remoteDev.username')}</Label>
                <Input id="remote-username" value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>{t('remoteDev.authMode')}</Label>
                <Select value={form.auth_mode} onValueChange={(value: 'agent' | 'key') => setForm((current) => ({ ...current, auth_mode: value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">{t('remoteDev.authAgent')}</SelectItem>
                    <SelectItem value="key">{t('remoteDev.authKey')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="remote-key">{t('remoteDev.privateKeyPath')}</Label>
                <Input id="remote-key" value={form.private_key_path} onChange={(event) => setForm((current) => ({ ...current, private_key_path: event.target.value }))} disabled={form.auth_mode !== 'key'} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="remote-root">{t('remoteDev.remoteRoot')}</Label>
                <Input id="remote-root" value={form.remote_root} onChange={(event) => setForm((current) => ({ ...current, remote_root: event.target.value }))} />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={handleSave} disabled={saving}>{saving ? t('remoteDev.saving') : t('remoteDev.save')}</Button>
              <Button variant="outline" onClick={handleTest} disabled={!selectedId || testing}>{testing ? t('remoteDev.testing') : t('remoteDev.testConnection')}</Button>

              <Button variant="destructive" onClick={handleDelete} disabled={!selectedId}>{t('remoteDev.delete')}</Button>
            </div>

            {statusMessage && (
              <p className="text-sm text-muted-foreground">{statusMessage}</p>
            )}

            {selectedConnection && (
              <div className="grid gap-2 rounded-lg border p-3 text-sm md:grid-cols-2">
                <div>
                  <div className="text-muted-foreground">{t('remoteDev.lastConnected')}</div>
                  <div>{selectedConnection.last_connected_at || t('remoteDev.neverConnected')}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">{t('remoteDev.lastError')}</div>
                  <div className="break-all">{selectedConnection.last_error || t('remoteDev.none')}</div>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('remoteDev.commandTitle')}</CardTitle>
          <CardDescription>{t('remoteDev.commandDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea value={command} onChange={(event) => setCommand(event.target.value)} rows={4} placeholder="pwd && uname -a" />
          <Button variant="outline" onClick={handleRunCommand} disabled={!selectedId || runningCommand}>{runningCommand ? t('remoteDev.runningCommand') : t('remoteDev.runCommand')}</Button>
          {commandOutput && <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{commandOutput}</pre>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('remoteDev.tunnels')}</CardTitle>
          <CardDescription>{t('remoteDev.tunnelsDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="tunnel-local-port">{t('remoteDev.localPort')}</Label>
              <Input id="tunnel-local-port" value={tunnelForm.local_port} onChange={(event) => setTunnelForm((current) => ({ ...current, local_port: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tunnel-remote-host">{t('remoteDev.remoteHost')}</Label>
              <Input id="tunnel-remote-host" value={tunnelForm.remote_host} onChange={(event) => setTunnelForm((current) => ({ ...current, remote_host: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tunnel-remote-port">{t('remoteDev.remotePort')}</Label>
              <Input id="tunnel-remote-port" value={tunnelForm.remote_port} onChange={(event) => setTunnelForm((current) => ({ ...current, remote_port: event.target.value }))} />
            </div>
          </div>
          <Button variant="outline" onClick={handleOpenTunnel} disabled={!selectedId || tunnelLoading}>{tunnelLoading ? t('remoteDev.openingTunnel') : t('remoteDev.openTunnel')}</Button>
          <div className="space-y-2">
            {tunnels.length === 0 && <p className="text-sm text-muted-foreground">{t('remoteDev.noTunnels')}</p>}
            {tunnels.map((tunnel) => (
              <div key={tunnel.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <div>
                  <div className="font-medium">localhost:{tunnel.local_port} → {tunnel.remote_host}:{tunnel.remote_port}</div>
                  <div className="text-muted-foreground">{tunnel.status}</div>
                </div>
                <Button variant="outline" size="sm" onClick={() => handleCloseTunnel(tunnel.id)}>{t('remoteDev.closeTunnel')}</Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
