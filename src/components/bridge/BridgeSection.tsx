"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, CheckmarkCircle02Icon, Alert02Icon, TelegramIcon, BubbleChatIcon, GameController01Icon } from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";
import type { ProviderModelGroup } from "@/types";
import {
  normalizeEngineType,
  normalizeReasoningEffort,
} from "@/lib/engine-defaults";

const FALLBACK_CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
import { DEFAULT_CODEX_MODEL_OPTIONS } from "@/lib/codex-model-options";
import { useDefaultReasoningEffort } from '@/hooks/useCliDefaults';
import { DEFAULT_GEMINI_MODEL_OPTIONS } from "@/lib/gemini-model-options";

interface AdapterStatus {
  channelType: string;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

interface BridgeSettings {
  remote_bridge_enabled: string;
  bridge_telegram_enabled: string;
  bridge_feishu_enabled: string;
  bridge_discord_enabled: string;
  bridge_auto_start: string;
  bridge_default_work_dir: string;
  bridge_default_engine_type: string;
  bridge_default_model: string;
  bridge_default_provider_id: string;
  bridge_default_reasoning_effort: string;
}

const DEFAULT_SETTINGS: BridgeSettings = {
  remote_bridge_enabled: "",
  bridge_telegram_enabled: "",
  bridge_feishu_enabled: "",
  bridge_discord_enabled: "",
  bridge_auto_start: "",
  bridge_default_work_dir: "",
  bridge_default_engine_type: "claude",
  bridge_default_model: "",
  bridge_default_provider_id: "",
  bridge_default_reasoning_effort: "",
};

const CLAUDE_FALLBACK_GROUPS: ProviderModelGroup[] = [
  {
    provider_id: "env",
    provider_name: "Claude Code",
    provider_type: "anthropic",
    models: [
      { value: "sonnet", label: "Sonnet 4.6" },
      { value: "opus", label: "Opus 4.6" },
      { value: "haiku", label: "Haiku 4.5" },
    ],
  },
];

const CODEX_FALLBACK_GROUPS: ProviderModelGroup[] = [
  {
    provider_id: "env",
    provider_name: "Codex CLI",
    provider_type: "codex",
    models: DEFAULT_CODEX_MODEL_OPTIONS,
  },
];

const GEMINI_FALLBACK_GROUPS: ProviderModelGroup[] = [
  {
    provider_id: "env",
    provider_name: "Gemini CLI",
    provider_type: "gemini",
    models: DEFAULT_GEMINI_MODEL_OPTIONS,
  },
];

export function BridgeSection() {
  const cliDefaultReasoning = useDefaultReasoningEffort('codex');
  const [settings, setSettings] = useState<BridgeSettings>(DEFAULT_SETTINGS);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [workDir, setWorkDir] = useState("");
  const [model, setModel] = useState("");
  const [engineType, setEngineType] = useState<"claude" | "codex" | "gemini">("claude");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [providerGroups, setProviderGroups] = useState<ProviderModelGroup[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { t } = useTranslation();
  const fallbackGroups = useMemo(
    () => (engineType === "codex"
      ? CODEX_FALLBACK_GROUPS
      : engineType === "gemini"
        ? GEMINI_FALLBACK_GROUPS
        : CLAUDE_FALLBACK_GROUPS),
    [engineType]
  );

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/bridge/settings");
      if (res.ok) {
        const data = await res.json();
        const s = { ...DEFAULT_SETTINGS, ...data.settings };
        const nextEngineType = normalizeEngineType(s.bridge_default_engine_type);
        setSettings(s);
        setEngineType(nextEngineType);
        setWorkDir(s.bridge_default_work_dir);
        const nextReasoning = nextEngineType === "codex"
          ? (
              normalizeReasoningEffort(s.bridge_default_reasoning_effort)
              || cliDefaultReasoning
            )
          : "";
        setReasoningEffort(nextReasoning);
        // Build composite value for Select: "provider_id::model"
        if (s.bridge_default_provider_id && s.bridge_default_model) {
          setModel(`${s.bridge_default_provider_id}::${s.bridge_default_model}`);
        } else if (s.bridge_default_model) {
          setModel(nextEngineType === "codex" || nextEngineType === "gemini" ? `env::${s.bridge_default_model}` : s.bridge_default_model);
        } else {
          setModel(nextEngineType === "codex" ? "env::gpt-5.3-codex" : nextEngineType === "gemini" ? "env::auto-gemini-2.5" : "");
        }
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/bridge");
      if (res.ok) {
        const data = await res.json();
        setBridgeStatus(data);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      const params = new URLSearchParams({ engine_type: engineType });
      const res = await fetch(`/api/providers/models?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (data.groups && data.groups.length > 0) {
          setProviderGroups(data.groups);
          return;
        }
      }
      setProviderGroups(fallbackGroups);
    } catch {
      setProviderGroups(fallbackGroups);
    }
  }, [engineType, fallbackGroups]);

  useEffect(() => {
    fetchSettings();
    fetchStatus();
  }, [fetchSettings, fetchStatus]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  useEffect(() => {
    if (providerGroups.length === 0) return;

    const hasComposite = model.includes("::");
    const hasCurrentComposite = providerGroups.some((group) =>
      group.models.some((m) => model === `${group.provider_id}::${m.value}`)
    );
    if (hasComposite && hasCurrentComposite) return;

    // Migrate legacy plain model values to provider::model.
    if (!hasComposite && model) {
      const preferredGroup =
        providerGroups.find((group) =>
          group.provider_id === settings.bridge_default_provider_id
          && group.models.some((m) => m.value === model)
        )
        || providerGroups.find((group) => group.models.some((m) => m.value === model));
      if (preferredGroup) {
        setModel(`${preferredGroup.provider_id}::${model}`);
        return;
      }
    }

    const firstGroup = providerGroups[0];
    const firstModel = firstGroup?.models[0];
    if (!firstModel) return;
    setModel(`${firstGroup.provider_id}::${firstModel.value}`);
  }, [providerGroups, model, settings.bridge_default_provider_id]);

  const [currentProviderId, currentModelValue] = model.includes("::")
    ? model.split("::")
    : ["", model];
  const currentModelOption = providerGroups
    .find((group) => group.provider_id === currentProviderId)
    ?.models.find((m) => m.value === currentModelValue)
    || providerGroups.flatMap((group) => group.models).find((m) => m.value === currentModelValue)
    || null;
  const reasoningOptions = useMemo(
    () => (engineType === "codex"
      ? (currentModelOption?.reasoning_efforts || [...FALLBACK_CODEX_EFFORTS])
          .map((effort) => normalizeReasoningEffort(effort))
          .filter((effort) => effort !== "")
      : []),
    [engineType, currentModelOption?.reasoning_efforts]
  );

  useEffect(() => {
    if (engineType !== "codex") {
      if (reasoningEffort !== "") setReasoningEffort("");
      return;
    }
    const normalizedCurrent = normalizeReasoningEffort(reasoningEffort);
    if (normalizedCurrent && reasoningOptions.includes(normalizedCurrent)) return;
    const fallback =
      normalizeReasoningEffort(currentModelOption?.default_reasoning_effort)
      || reasoningOptions[0]
      || cliDefaultReasoning;
    setReasoningEffort(fallback || "");
  }, [engineType, reasoningEffort, reasoningOptions, currentModelOption?.default_reasoning_effort]);

  // Poll bridge status while bridge is running
  useEffect(() => {
    if (bridgeStatus?.running) {
      pollRef.current = setInterval(fetchStatus, 5000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [bridgeStatus?.running, fetchStatus]);

  const saveSettings = async (updates: Partial<BridgeSettings>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/bridge/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: updates }),
      });
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...updates }));
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = (checked: boolean) => {
    saveSettings({ remote_bridge_enabled: checked ? "true" : "" });
  };

  const handleToggleTelegram = (checked: boolean) => {
    saveSettings({ bridge_telegram_enabled: checked ? "true" : "" });
  };

  const handleToggleFeishu = (checked: boolean) => {
    saveSettings({ bridge_feishu_enabled: checked ? "true" : "" });
  };

  const handleToggleDiscord = (checked: boolean) => {
    saveSettings({ bridge_discord_enabled: checked ? "true" : "" });
  };

  const handleSaveDefaults = () => {
    // Split composite "provider_id::model" value
    const parts = model.split("::");
    const providerId = parts.length === 2 ? parts[0] : "";
    const modelValue = parts.length === 2 ? parts[1] : model;
    const persistedReasoningEffort = engineType === "codex"
      ? (
          normalizeReasoningEffort(reasoningEffort)
          || normalizeReasoningEffort(currentModelOption?.default_reasoning_effort)
          || cliDefaultReasoning
        )
      : "";
    saveSettings({
      bridge_default_work_dir: workDir,
      bridge_default_engine_type: engineType,
      bridge_default_model: modelValue,
      bridge_default_provider_id: providerId,
      bridge_default_reasoning_effort: persistedReasoningEffort || "",
    });
  };

  const handleBrowseFolder = async () => {
    try {
      const api = (window as unknown as Record<string, unknown>).electronAPI as
        | { dialog: { openFolder: (opts?: { defaultPath?: string; title?: string }) => Promise<{ canceled: boolean; filePaths: string[] }> } }
        | undefined;
      if (api?.dialog?.openFolder) {
        const result = await api.dialog.openFolder({
          defaultPath: workDir || undefined,
          title: t("bridge.defaultWorkDir"),
        });
        if (!result.canceled && result.filePaths[0]) {
          setWorkDir(result.filePaths[0]);
        }
      }
    } catch {
      // Not in Electron or dialog unavailable
    }
  };

  const handleStartBridge = async () => {
    setStarting(true);
    try {
      await fetch("/api/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      await fetchStatus();
    } catch {
      // ignore
    } finally {
      setStarting(false);
    }
  };

  const handleStopBridge = async () => {
    setStopping(true);
    try {
      await fetch("/api/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      await fetchStatus();
    } catch {
      // ignore
    } finally {
      setStopping(false);
    }
  };

  const handleToggleAutoStart = (checked: boolean) => {
    saveSettings({ bridge_auto_start: checked ? "true" : "" });
  };

  const isEnabled = settings.remote_bridge_enabled === "true";
  const isTelegramEnabled = settings.bridge_telegram_enabled === "true";
  const isFeishuEnabled = settings.bridge_feishu_enabled === "true";
  const isDiscordEnabled = settings.bridge_discord_enabled === "true";
  const isAutoStart = settings.bridge_auto_start === "true";
  const isRunning = bridgeStatus?.running ?? false;
  const adapterCount = bridgeStatus?.adapters?.length ?? 0;

  return (
    <div className="max-w-3xl space-y-6">
      {/* Enable/Disable Master Toggle */}
      <div
        className={`rounded-lg border p-4 transition-shadow hover:shadow-sm ${
          isEnabled
            ? "border-blue-500/50 bg-blue-500/5"
            : "border-border/50"
        }`}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">{t("bridge.title")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("bridge.description")}
            </p>
          </div>
          <Switch
            checked={isEnabled}
            onCheckedChange={handleToggleEnabled}
            disabled={saving}
          />
        </div>
        {isEnabled && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-600 dark:text-blue-400">
            <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
            {t("bridge.activeHint")}
          </div>
        )}
      </div>

      {/* Bridge Status + Start/Stop */}
      {isEnabled && (
        <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium">{t("bridge.status")}</h2>
              <p className="text-xs text-muted-foreground">
                {isRunning
                  ? t("bridge.activeBindings", { count: String(adapterCount) })
                  : t("bridge.noBindings")}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div
                className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs ${
                  isRunning
                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                <HugeiconsIcon
                  icon={isRunning ? CheckmarkCircle02Icon : Alert02Icon}
                  className="h-3.5 w-3.5 shrink-0"
                />
                {isRunning
                  ? t("bridge.statusConnected")
                  : t("bridge.statusDisconnected")}
              </div>
              {isRunning ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleStopBridge}
                  disabled={stopping}
                >
                  {stopping ? (
                    <HugeiconsIcon
                      icon={Loading02Icon}
                      className="h-3.5 w-3.5 animate-spin mr-1.5"
                    />
                  ) : null}
                  {stopping ? t("bridge.stopping") : t("bridge.stop")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleStartBridge}
                  disabled={starting}
                >
                  {starting ? (
                    <HugeiconsIcon
                      icon={Loading02Icon}
                      className="h-3.5 w-3.5 animate-spin mr-1.5"
                    />
                  ) : null}
                  {starting ? t("bridge.starting") : t("bridge.start")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Channel Toggles */}
      {isEnabled && (
        <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
          <div>
            <h2 className="text-sm font-medium">{t("bridge.channels")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("bridge.channelsDesc")}
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <HugeiconsIcon
                  icon={TelegramIcon}
                  className="h-4 w-4 text-muted-foreground"
                />
                <div>
                  <p className="text-sm">{t("bridge.telegramChannel")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("bridge.telegramChannelDesc")}
                  </p>
                </div>
              </div>
              <Switch
                checked={isTelegramEnabled}
                onCheckedChange={handleToggleTelegram}
                disabled={saving}
              />
            </div>

            <div className="flex items-center justify-between border-t border-border/30 pt-3">
              <div className="flex items-center gap-3">
                <HugeiconsIcon
                  icon={BubbleChatIcon}
                  className="h-4 w-4 text-muted-foreground"
                />
                <div>
                  <p className="text-sm">{t("bridge.feishuChannel")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("bridge.feishuChannelDesc")}
                  </p>
                </div>
              </div>
              <Switch
                checked={isFeishuEnabled}
                onCheckedChange={handleToggleFeishu}
                disabled={saving}
              />
            </div>

            <div className="flex items-center justify-between border-t border-border/30 pt-3">
              <div className="flex items-center gap-3">
                <HugeiconsIcon
                  icon={GameController01Icon}
                  className="h-4 w-4 text-muted-foreground"
                />
                <div>
                  <p className="text-sm">{t("bridge.discordChannel")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("bridge.discordChannelDesc")}
                  </p>
                </div>
              </div>
              <Switch
                checked={isDiscordEnabled}
                onCheckedChange={handleToggleDiscord}
                disabled={saving}
              />
            </div>

            <div className="flex items-center justify-between border-t border-border/30 pt-3">
              <div>
                <p className="text-sm">{t("bridge.autoStart")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("bridge.autoStartDesc")}
                </p>
              </div>
              <Switch
                checked={isAutoStart}
                onCheckedChange={handleToggleAutoStart}
                disabled={saving}
              />
            </div>
          </div>
        </div>
      )}

      {/* Adapter Status */}
      {isEnabled && isRunning && adapterCount > 0 && (
        <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
          <div>
            <h2 className="text-sm font-medium">{t("bridge.adapters")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("bridge.adaptersDesc")}
            </p>
          </div>

          <div className="space-y-2">
            {bridgeStatus?.adapters.map((adapter) => (
              <div
                key={adapter.channelType}
                className="rounded-md border border-border/30 px-3 py-2 space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium capitalize">
                    {adapter.channelType}
                  </span>
                  <div
                    className={`rounded px-2 py-0.5 text-xs ${
                      adapter.running
                        ? "bg-green-500/10 text-green-600 dark:text-green-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {adapter.running
                      ? t("bridge.adapterRunning")
                      : t("bridge.adapterStopped")}
                  </div>
                </div>
                {adapter.lastMessageAt && (
                  <p className="text-xs text-muted-foreground">
                    {t("bridge.adapterLastMessage")}: {new Date(adapter.lastMessageAt).toLocaleString()}
                  </p>
                )}
                {adapter.error && (
                  <p className="text-xs text-red-500">
                    {t("bridge.adapterLastError")}: {adapter.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Default Settings */}
      {isEnabled && (
        <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
          <div>
            <h2 className="text-sm font-medium">{t("bridge.defaults")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("bridge.defaultsDesc")}
            </p>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t("bridge.defaultWorkDir")}
              </label>
              <div className="flex gap-2">
                <Input
                  value={workDir}
                  onChange={(e) => setWorkDir(e.target.value)}
                  placeholder="/path/to/project"
                  className="font-mono text-sm"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleBrowseFolder}
                  className="shrink-0"
                >
                  {t("bridge.browse")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t("bridge.defaultWorkDirHint")}
              </p>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t("bridge.defaultEngine")}
              </label>
              <Select
                value={engineType}
                onValueChange={(value) => {
                  const nextEngineType = normalizeEngineType(value);
                  setEngineType(nextEngineType);
                  if (nextEngineType === "codex") {
                    const normalized = normalizeReasoningEffort(reasoningEffort)
                      || cliDefaultReasoning;
                    setReasoningEffort(normalized || "");
                  } else {
                    setReasoningEffort("");
                  }
                }}
              >
                <SelectTrigger className="w-full text-sm font-mono">
                  <SelectValue placeholder={t("bridge.defaultEngineHint")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">{t("bridge.engineClaude")}</SelectItem>
                  <SelectItem value="codex">{t("bridge.engineCodex")}</SelectItem>
                  <SelectItem value="gemini">{t("bridge.engineGemini")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {t("bridge.defaultEngineHint")}
              </p>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t("bridge.defaultModel")}
              </label>
              {providerGroups.length > 0 ? (
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger className="w-full text-sm font-mono">
                    <SelectValue placeholder={t("bridge.defaultModelHint")} />
                  </SelectTrigger>
                  <SelectContent>
                    {providerGroups.map((group) => (
                      <SelectGroup key={group.provider_id}>
                        <SelectLabel>{group.provider_name}</SelectLabel>
                        {group.models.map((m) => (
                          <SelectItem
                            key={`${group.provider_id}::${m.value}`}
                            value={`${group.provider_id}::${m.value}`}
                          >
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={engineType === "codex" ? "gpt-5.3-codex" : engineType === "gemini" ? "auto-gemini-2.5" : "sonnet"}
                  className="font-mono text-sm"
                />
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {t("bridge.defaultModelHint")}
              </p>
            </div>

            {engineType === "codex" && (
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  {t("bridge.defaultReasoningEffort")}
                </label>
                <Select
                  value={
                    normalizeReasoningEffort(reasoningEffort)
                    || normalizeReasoningEffort(currentModelOption?.default_reasoning_effort)
                    || cliDefaultReasoning
                    || "medium"
                  }
                  onValueChange={(value) => setReasoningEffort(normalizeReasoningEffort(value) || "medium")}
                >
                  <SelectTrigger className="w-full text-sm font-mono">
                    <SelectValue placeholder={t("bridge.defaultReasoningEffortHint")} />
                  </SelectTrigger>
                  <SelectContent>
                    {reasoningOptions.map((effort) => (
                      <SelectItem key={effort} value={effort}>
                        {effort}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  {t("bridge.defaultReasoningEffortHint")}
                </p>
              </div>
            )}
          </div>

          <Button
            size="sm"
            onClick={handleSaveDefaults}
            disabled={saving}
          >
            {saving ? t("common.loading") : t("common.save")}
          </Button>
        </div>
      )}
    </div>
  );
}
