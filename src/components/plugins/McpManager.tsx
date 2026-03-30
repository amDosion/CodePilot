"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, ListViewIcon, CodeIcon, Loading02Icon } from "@hugeicons/core-free-icons";
import { McpServerList } from "@/components/plugins/McpServerList";
import { McpServerEditor } from "@/components/plugins/McpServerEditor";
import { ConfigEditor } from "@/components/plugins/ConfigEditor";
import { useTranslation } from "@/hooks/useTranslation";
import { buildEnginePreferenceTarget, readActiveEngine } from "@/lib/engine-preferences";
import type { MCPServer } from "@/types";
import type { WorkspaceMode } from "@/hooks/usePanel";

type RuntimeEngine = "claude" | "codex" | "gemini";

interface McpResponse {
  mcpServers?: Record<string, MCPServer>;
  engine?: RuntimeEngine;
  format?: "json" | "toml";
  path?: string;
  error?: string;
}

interface McpManagerProps {
  workspaceMode?: WorkspaceMode;
  remoteConnectionId?: string;
}

export function McpManager({ workspaceMode, remoteConnectionId }: McpManagerProps = {}) {
  const isRemote = workspaceMode === 'remote' && !!remoteConnectionId;
  const { t } = useTranslation();
  const [servers, setServers] = useState<Record<string, MCPServer>>({});
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | undefined>();
  const [editingServer, setEditingServer] = useState<MCPServer | undefined>();
  const [tab, setTab] = useState<"list" | "json">("list");
  const [error, setError] = useState<string | null>(null);
  const [engineType, setEngineType] = useState<RuntimeEngine>("claude");
  const [configPath, setConfigPath] = useState("");
  const [configFormat, setConfigFormat] = useState<"json" | "toml">("json");

  const runtimeLabel = engineType === "codex"
    ? t("chatList.providerCodex")
    : engineType === "gemini"
      ? t("chatList.providerGemini")
      : t("chatList.providerClaude");

  const fetchServers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      let data: McpResponse;
      if (isRemote) {
        const res = await fetch("/api/remote/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connection_id: remoteConnectionId, engine_type: engineType, action: "list" }),
        });
        data = await res.json() as McpResponse;
      } else {
        const params = new URLSearchParams({ engine_type: engineType });
        const res = await fetch(`/api/plugins/mcp?${params.toString()}`, { cache: "no-store" });
        data = await res.json() as McpResponse;
      }
      if (data.mcpServers) {
        setServers(data.mcpServers);
        setConfigPath(data.path || "");
        setConfigFormat(data.format === "toml" ? "toml" : "json");
      } else if (data.error) {
        setError(data.error);
      }
    } catch (err) {
      console.error("Failed to fetch MCP servers:", err);
      setError("Failed to connect to API");
    } finally {
      setLoading(false);
    }
  }, [engineType, isRemote, remoteConnectionId]);

  useEffect(() => {
    const syncEngine = () => {
      setEngineType(readActiveEngine(buildEnginePreferenceTarget(
        workspaceMode === 'remote' ? 'remote' : 'local',
        remoteConnectionId,
      )));
    };

    syncEngine();
    window.addEventListener("engine-changed", syncEngine);
    window.addEventListener("focus", syncEngine);
    return () => {
      window.removeEventListener("engine-changed", syncEngine);
      window.removeEventListener("focus", syncEngine);
    };
  }, [remoteConnectionId, workspaceMode]);

  useEffect(() => {
    fetchServers();
  }, [fetchServers, engineType]);

  function handleEdit(name: string, server: MCPServer) {
    setEditingName(name);
    setEditingServer(server);
    setEditorOpen(true);
  }

  function handleAdd() {
    setEditingName(undefined);
    setEditingServer(undefined);
    setEditorOpen(true);
  }

  async function handleDelete(name: string) {
    try {
      if (isRemote) {
        const res = await fetch("/api/remote/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connection_id: remoteConnectionId, engine_type: engineType, action: "delete", server_name: name }),
        });
        if (res.ok) {
          setServers((prev) => { const updated = { ...prev }; delete updated[name]; return updated; });
        } else {
          const data = await res.json();
          console.error("Failed to delete MCP server:", data.error);
        }
      } else {
        const params = new URLSearchParams({ engine_type: engineType });
        const res = await fetch(`/api/plugins/mcp/${encodeURIComponent(name)}?${params.toString()}`, {
          method: "DELETE",
        });
        if (res.ok) {
          setServers((prev) => { const updated = { ...prev }; delete updated[name]; return updated; });
        } else {
          const data = await res.json();
          console.error("Failed to delete MCP server:", data.error);
        }
      }
    } catch (err) {
      console.error("Failed to delete MCP server:", err);
    }
  }

  async function handleSave(name: string, server: MCPServer) {
    try {
      if (isRemote) {
        if (editingName && editingName !== name) {
          // Rename: delete old + add new via save_all
          const updated = { ...servers };
          delete updated[editingName];
          updated[name] = server;
          await fetch("/api/remote/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connection_id: remoteConnectionId, engine_type: engineType, action: "save_all", server_config: updated }),
          });
          setServers(updated);
        } else if (editingName) {
          await fetch("/api/remote/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connection_id: remoteConnectionId, engine_type: engineType, action: "update", server_name: name, server_config: server }),
          });
          setServers((prev) => ({ ...prev, [name]: server }));
        } else {
          const res = await fetch("/api/remote/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connection_id: remoteConnectionId, engine_type: engineType, action: "add", server_name: name, server_config: server }),
          });
          if (res.ok) {
            setServers((prev) => ({ ...prev, [name]: server }));
          } else {
            const data = await res.json();
            console.error("Failed to add MCP server:", data.error);
          }
        }
      } else {
        if (editingName && editingName !== name) {
          const updated = { ...servers };
          delete updated[editingName];
          updated[name] = server;
          await fetch("/api/plugins/mcp", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ engine_type: engineType, mcpServers: updated }),
          });
          setServers(updated);
        } else if (editingName) {
          const updated = { ...servers, [name]: server };
          await fetch("/api/plugins/mcp", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ engine_type: engineType, mcpServers: updated }),
          });
          setServers(updated);
        } else {
          const res = await fetch("/api/plugins/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ engine_type: engineType, name, server }),
          });
          if (res.ok) {
            setServers((prev) => ({ ...prev, [name]: server }));
          } else {
            const data = await res.json();
            console.error("Failed to add MCP server:", data.error);
          }
        }
      }
    } catch (err) {
      console.error("Failed to save MCP server:", err);
    }
  }

  async function handleJsonSave(jsonStr: string) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (isRemote) {
        await fetch("/api/remote/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connection_id: remoteConnectionId, engine_type: engineType, action: "save_all", server_config: parsed }),
        });
      } else {
        await fetch("/api/plugins/mcp", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ engine_type: engineType, mcpServers: parsed }),
        });
      }
      setServers(parsed);
    } catch (err) {
      console.error("Failed to save MCP config:", err);
    }
  }

  const serverCount = Object.keys(servers).length;

  return (
    <div className="h-full overflow-auto">
      {isRemote && (
        <div className="mb-4 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
          <p className="text-sm font-medium text-blue-600 dark:text-blue-400">
            {t('settings.remoteModeBanner', { host: '' })}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('settings.remoteModeBannerDesc')}
          </p>
        </div>
      )}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">{t('extensions.mcpServers')}</h3>
            <Badge variant="outline">{runtimeLabel}</Badge>
            {serverCount > 0 && (
              <span className="text-sm text-muted-foreground">
                ({serverCount})
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t("mcp.runtimeConfigDesc", {
              runtime: runtimeLabel,
              path: configPath || (
                engineType === "codex"
                  ? "~/.codex/config.toml"
                  : engineType === "gemini"
                    ? "~/.gemini/settings.json"
                    : "~/.claude/settings.json"
              ),
            })}
            {configFormat === "toml" ? ` ${t("mcp.tomlBackedHint")}` : ""}
          </p>
        </div>
        <Button size="sm" className="gap-1" onClick={handleAdd}>
          <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
          {t('mcp.addServer')}
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 mb-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as "list" | "json")}>
        <TabsList>
          <TabsTrigger value="list" className="gap-1.5">
            <HugeiconsIcon icon={ListViewIcon} className="h-3.5 w-3.5" />
            {t('mcp.listTab')}
          </TabsTrigger>
          <TabsTrigger value="json" className="gap-1.5">
            <HugeiconsIcon icon={CodeIcon} className="h-3.5 w-3.5" />
            {t('mcp.jsonTab')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
              <p className="text-sm">{t('mcp.loadingServers')}</p>
            </div>
          ) : (
            <McpServerList
              servers={servers}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          )}
        </TabsContent>

        <TabsContent value="json" className="mt-4">
          <ConfigEditor
            value={JSON.stringify(servers, null, 2)}
            onSave={handleJsonSave}
            label={t('mcp.serverConfig')}
          />
        </TabsContent>
      </Tabs>

      <McpServerEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        name={editingName}
        server={editingServer}
        onSave={handleSave}
      />
    </div>
  );
}
