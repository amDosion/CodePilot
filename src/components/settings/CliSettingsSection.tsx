"use client";

import { useState, useEffect, useCallback } from "react";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FloppyDiskIcon,
  ReloadIcon,
  CodeIcon,
  SlidersHorizontalIcon,
  Loading02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { CliAuthSection } from "./CliAuthSection";
import { useTranslation } from "@/hooks/useTranslation";
import { buildEnginePreferenceTarget, persistEnginePreferences, readActiveEngine } from "@/lib/engine-preferences";
import type { TranslationKey } from "@/i18n";

type RuntimeEngine = "claude" | "codex" | "gemini";
type SourceFormat = "json" | "toml";
type EditorMode = "form" | "source";

interface SettingsData {
  [key: string]: unknown;
}

interface SettingsResponse {
  engine: RuntimeEngine;
  format: SourceFormat;
  path: string;
  settings: SettingsData;
}

interface KnownField {
  key: string;
  label: TranslationKey;
  description: TranslationKey;
  type: "string" | "object";
}

const KNOWN_FIELDS_BY_ENGINE: Record<RuntimeEngine, KnownField[]> = {
  claude: [
    {
      key: "permissions",
      label: "cli.permissions",
      description: "cli.permissionsDesc",
      type: "object",
    },
    {
      key: "env",
      label: "cli.envVars",
      description: "cli.envVarsDesc",
      type: "object",
    },
  ],
  codex: [
    {
      key: "model",
      label: "cli.field.model",
      description: "cli.field.modelDesc",
      type: "string",
    },
    {
      key: "model_reasoning_effort",
      label: "cli.field.modelReasoningEffort",
      description: "cli.field.modelReasoningEffortDesc",
      type: "string",
    },
    {
      key: "approval_policy",
      label: "cli.field.approvalPolicy",
      description: "cli.field.approvalPolicyDesc",
      type: "string",
    },
    {
      key: "personality",
      label: "cli.field.personality",
      description: "cli.field.personalityDesc",
      type: "string",
    },
  ],
  gemini: [
    {
      key: "model",
      label: "cli.field.model",
      description: "cli.field.modelDesc",
      type: "object",
    },
    {
      key: "context",
      label: "cli.field.context",
      description: "cli.field.contextDesc",
      type: "object",
    },
    {
      key: "security",
      label: "cli.field.security",
      description: "cli.field.securityDesc",
      type: "object",
    },
    {
      key: "mcpServers",
      label: "cli.field.mcpServers",
      description: "cli.field.mcpServersDesc",
      type: "object",
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeSettings(settings: SettingsData, format: SourceFormat): string {
  return format === "toml"
    ? stringifyToml(settings)
    : JSON.stringify(settings, null, 2);
}

function parseSourceSettings(source: string, format: SourceFormat): SettingsData {
  const parsed = format === "toml" ? parseToml(source) : JSON.parse(source);
  if (!isRecord(parsed)) {
    throw new Error("Settings source must decode to an object");
  }
  return parsed;
}

interface CliSettingsSectionProps {
  workspaceMode?: 'local' | 'remote';
  remoteConnectionId?: string;
}

export function CliSettingsSection({ workspaceMode = 'local', remoteConnectionId = '' }: CliSettingsSectionProps) {
  const isRemote = workspaceMode === 'remote' && !!remoteConnectionId;
  const [activeEngine, setActiveEngine] = useState<RuntimeEngine | null>(null);
  const [settings, setSettings] = useState<SettingsData>({});
  const [originalSettings, setOriginalSettings] = useState<SettingsData>({});
  const [sourceText, setSourceText] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [sourceFormat, setSourceFormat] = useState<SourceFormat>("json");
  const [settingsPath, setSettingsPath] = useState("");
  const [editorMode, setEditorMode] = useState<EditorMode>("form");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingSaveAction, setPendingSaveAction] = useState<EditorMode | null>(null);
  const { t } = useTranslation();

  const dynamicFieldLabels: Record<string, TranslationKey> = {
    skipDangerousModePermissionPrompt: "cli.field.skipDangerousModePermissionPrompt",
    verbose: "cli.field.verbose",
    theme: "cli.field.theme",
  };

  const syncEngineFromRuntime = useCallback(() => {
    setActiveEngine(readActiveEngine(buildEnginePreferenceTarget(workspaceMode, remoteConnectionId)));
  }, [remoteConnectionId, workspaceMode]);

  const handleEngineChange = useCallback((engine: RuntimeEngine) => {
    setActiveEngine(engine);
    persistEnginePreferences(engine, {}, buildEnginePreferenceTarget(workspaceMode, remoteConnectionId));
    window.dispatchEvent(new Event("engine-changed"));
  }, [remoteConnectionId, workspaceMode]);

  const fetchSettings = useCallback(async (engine: RuntimeEngine) => {
    setLoading(true);
    try {
      let data: SettingsResponse;
      if (isRemote) {
        const res = await fetch('/api/remote/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connection_id: remoteConnectionId, engine }),
        });
        if (!res.ok) throw new Error('Failed to fetch remote settings');
        data = await res.json() as SettingsResponse;
      } else {
        const res = await fetch(`/api/settings?engine=${engine}`, { cache: "no-store" });
        if (!res.ok) throw new Error('Failed to fetch settings');
        data = await res.json() as SettingsResponse;
      }
      const nextSettings = data.settings || {};
      const nextFormat = data.format === "toml" ? "toml" : "json";
      setSettings(nextSettings);
      setOriginalSettings(nextSettings);
      setSourceFormat(nextFormat);
      setSettingsPath(data.path || "");
      setSourceText(serializeSettings(nextSettings, nextFormat));
      setSourceError("");
    } catch {
      setSettings({});
      setOriginalSettings({});
      setSourceText("");
      setSourceError("");
    } finally {
      setLoading(false);
    }
  }, [isRemote, remoteConnectionId]);

  useEffect(() => {
    syncEngineFromRuntime();
    window.addEventListener("engine-changed", syncEngineFromRuntime);
    window.addEventListener("focus", syncEngineFromRuntime);
    return () => {
      window.removeEventListener("engine-changed", syncEngineFromRuntime);
      window.removeEventListener("focus", syncEngineFromRuntime);
    };
  }, [syncEngineFromRuntime]);

  useEffect(() => {
    if (!activeEngine) return;
    fetchSettings(activeEngine);
  }, [activeEngine, fetchSettings]);

  const hasChanges = JSON.stringify(settings) !== JSON.stringify(originalSettings);
  const knownFields = activeEngine ? KNOWN_FIELDS_BY_ENGINE[activeEngine] : [];
  const sourceLabel = sourceFormat === "toml" ? "TOML" : t("cli.json");
  const sourcePlaceholder = sourceFormat === "toml"
    ? 'model = "gpt-5.4"'
    : '{"key": "value"}';
  const runtimeCommand = activeEngine === "codex"
    ? "codex login"
    : activeEngine === "gemini"
      ? "gemini"
      : "claude login";
  const runtimeHintBody = activeEngine === "codex"
    ? t("cli.runtimeHintBodyCodex", { path: settingsPath || "~/.codex/config.toml" })
    : activeEngine === "gemini"
      ? t("cli.runtimeHintBodyGemini", { path: settingsPath || "~/.gemini/settings.json" })
      : t("cli.runtimeHintBodyClaude", { path: settingsPath || "~/.claude/settings.json" });

  const handleSave = async (mode: EditorMode) => {
    let dataToSave: SettingsData;

    if (!activeEngine) return;

    if (mode === "source") {
      try {
        dataToSave = parseSourceSettings(sourceText, sourceFormat);
        setSourceError("");
      } catch {
        setSourceError(
          sourceFormat === "toml" ? t("cli.formatErrorToml") : t("cli.formatError")
        );
        return;
      }
    } else {
      dataToSave = settings;
    }

    setSaving(true);
    try {
      let res: Response;
      if (isRemote) {
        res = await fetch("/api/remote/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connection_id: remoteConnectionId,
            engine: activeEngine,
            settings: dataToSave,
          }),
        });
      } else {
        res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            engine: activeEngine,
            settings: dataToSave,
          }),
        });
      }

      if (res.ok) {
        setSettings(dataToSave);
        setOriginalSettings(dataToSave);
        setSourceText(serializeSettings(dataToSave, sourceFormat));
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
      setShowConfirmDialog(false);
      setPendingSaveAction(null);
    }
  };

  const handleReset = () => {
    setSettings(originalSettings);
    setSourceText(serializeSettings(originalSettings, sourceFormat));
    setSourceError("");
  };

  const handleFormatSource = () => {
    try {
      const parsed = parseSourceSettings(sourceText, sourceFormat);
      setSourceText(serializeSettings(parsed, sourceFormat));
      setSourceError("");
    } catch {
      setSourceError(
        sourceFormat === "toml" ? t("cli.formatErrorToml") : t("cli.formatError")
      );
    }
  };

  const confirmSave = (mode: EditorMode) => {
    setPendingSaveAction(mode);
    setShowConfirmDialog(true);
  };

  const updateField = (key: string, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const renderFieldControl = (key: string, value: unknown, type?: KnownField["type"]) => {
    if (type === "string" || typeof value === "string" || typeof value === "number") {
      return (
        <Input
          value={String(value ?? "")}
          onChange={(e) => updateField(key, e.target.value)}
          className="mt-2"
        />
      );
    }

    if (typeof value === "boolean") {
      return (
        <div className="mt-2 flex items-center gap-2">
          <Switch
            checked={value}
            onCheckedChange={(checked) => updateField(key, checked)}
          />
          <span className="text-sm text-muted-foreground">
            {value ? t("common.enabled") : t("common.disabled")}
          </span>
        </div>
      );
    }

    return (
      <Textarea
        value={
          typeof value === "object"
            ? JSON.stringify(value ?? {}, null, 2)
            : String(value ?? "")
        }
        onChange={(e) => {
          try {
            updateField(key, JSON.parse(e.target.value));
          } catch {
            updateField(key, e.target.value);
          }
        }}
        className="mt-2 font-mono text-sm"
        rows={4}
      />
    );
  };

  if (loading || !activeEngine) {
    return (
      <div className="flex items-center justify-center py-12">
        <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">{t("cli.loadingSettings")}</span>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => handleEngineChange("claude")}
          className={cn(
            "rounded-md border px-3 py-1.5 text-sm transition-colors",
            activeEngine === "claude"
              ? "border-border bg-accent text-accent-foreground"
              : "border-border/60 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          )}
        >
          {t("cli.engineClaude")}
        </button>
        <button
          onClick={() => handleEngineChange("codex")}
          className={cn(
            "rounded-md border px-3 py-1.5 text-sm transition-colors",
            activeEngine === "codex"
              ? "border-border bg-accent text-accent-foreground"
              : "border-border/60 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          )}
        >
          {t("cli.engineCodex")}
        </button>
        <button
          onClick={() => handleEngineChange("gemini")}
          className={cn(
            "rounded-md border px-3 py-1.5 text-sm transition-colors",
            activeEngine === "gemini"
              ? "border-border bg-accent text-accent-foreground"
              : "border-border/60 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          )}
        >
          {t("cli.engineGemini")}
        </button>
      </div>

      <div className="mb-4 rounded-lg border border-border/50 bg-muted/20 p-4">
        <p className="text-sm font-medium">{t("cli.runtimeHintTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{runtimeHintBody}</p>
        <code className="mt-2 block rounded-md bg-muted px-3 py-2 text-xs">{runtimeCommand}</code>
      </div>

      {activeEngine && <CliAuthSection engineType={activeEngine} />}

      <Tabs value={editorMode} onValueChange={(value) => setEditorMode(value as EditorMode)}>
        <TabsList className="mb-4">
          <TabsTrigger value="form" className="gap-2">
            <HugeiconsIcon icon={SlidersHorizontalIcon} className="h-4 w-4" />
            {t("cli.form")}
          </TabsTrigger>
          <TabsTrigger value="source" className="gap-2">
            <HugeiconsIcon icon={CodeIcon} className="h-4 w-4" />
            {sourceLabel}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="form">
          <div className="space-y-6">
            <div className="rounded-lg border border-border/50 p-4">
              <Label className="text-sm font-medium">{t("cli.runtimeFile")}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{settingsPath}</p>
            </div>

            {knownFields.map((field) => (
              <div
                key={field.key}
                className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm"
              >
                <Label className="text-sm font-medium">{t(field.label)}</Label>
                <p className="mb-2 text-xs text-muted-foreground">{t(field.description)}</p>
                {renderFieldControl(field.key, settings[field.key], field.type)}
              </div>
            ))}

            {Object.entries(settings)
              .filter(([key]) => !knownFields.some((field) => field.key === key))
              .map(([key, value]) => (
                <div
                  key={key}
                  className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm"
                >
                  <Label className="text-sm font-medium">
                    {dynamicFieldLabels[key] ? t(dynamicFieldLabels[key]) : key}
                  </Label>
                  {renderFieldControl(key, value)}
                </div>
              ))}

            <div className="flex items-center gap-3">
              <Button onClick={() => confirmSave("form")} disabled={!hasChanges || saving} className="gap-2">
                {saving ? (
                  <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
                ) : (
                  <HugeiconsIcon icon={FloppyDiskIcon} className="h-4 w-4" />
                )}
                {saving ? t("provider.saving") : t("cli.save")}
              </Button>
              <Button variant="outline" onClick={handleReset} disabled={!hasChanges} className="gap-2">
                <HugeiconsIcon icon={ReloadIcon} className="h-4 w-4" />
                {t("cli.reset")}
              </Button>
              {saveSuccess && (
                <span className="text-sm text-green-600 dark:text-green-400">
                  {t("cli.settingsSaved")}
                </span>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="source">
          <div className="space-y-4">
            <div className="rounded-lg border border-border/50 p-4">
              <Label className="text-sm font-medium">{t("cli.runtimeFile")}</Label>
              <p className="mt-1 text-xs text-muted-foreground">{settingsPath}</p>
            </div>

            <Textarea
              value={sourceText}
              onChange={(e) => {
                setSourceText(e.target.value);
                setSourceError("");
              }}
              className="min-h-[400px] font-mono text-sm"
              placeholder={sourcePlaceholder}
            />
            {sourceError && <p className="text-sm text-destructive">{sourceError}</p>}

            <div className="flex items-center gap-3">
              <Button onClick={() => confirmSave("source")} disabled={saving} className="gap-2">
                {saving ? (
                  <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
                ) : (
                  <HugeiconsIcon icon={FloppyDiskIcon} className="h-4 w-4" />
                )}
                {saving ? t("provider.saving") : t("cli.save")}
              </Button>
              <Button variant="outline" onClick={handleFormatSource} className="gap-2">
                <HugeiconsIcon icon={CodeIcon} className="h-4 w-4" />
                {t("cli.format")}
              </Button>
              <Button variant="outline" onClick={handleReset} className="gap-2">
                <HugeiconsIcon icon={ReloadIcon} className="h-4 w-4" />
                {t("cli.reset")}
              </Button>
              {saveSuccess && (
                <span className="text-sm text-green-600 dark:text-green-400">
                  {t("cli.settingsSaved")}
                </span>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cli.confirmSaveTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("cli.confirmSaveDesc", { path: settingsPath })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingSaveAction && handleSave(pendingSaveAction)}>
              {t("common.save")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
