"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePanel } from "@/hooks/usePanel";

import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, Search01Icon, ZapIcon, Loading02Icon } from "@hugeicons/core-free-icons";
import { SkillListItem } from "./SkillListItem";
import { SkillEditor } from "./SkillEditor";
import { CreateSkillDialog } from "./CreateSkillDialog";
import { MarketplaceBrowser } from "./MarketplaceBrowser";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { buildEnginePreferenceTarget, persistEnginePreferences, readActiveEngine } from "@/lib/engine-preferences";
import type { SkillItem } from "./SkillListItem";

type ViewTab = "local" | "marketplace";
type RuntimeEngine = "claude" | "codex" | "gemini";

export function SkillsManager() {
  const { workingDirectory, workspaceMode, remoteConnectionId } = usePanel();
  const { t } = useTranslation();
  const isRemote = workspaceMode === 'remote' && !!remoteConnectionId;
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [selected, setSelected] = useState<SkillItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [viewTab, setViewTab] = useState<ViewTab>("local");
  const [engineType, setEngineType] = useState<RuntimeEngine>(() => readActiveEngine(
    buildEnginePreferenceTarget(workspaceMode, remoteConnectionId),
  ));

  const fetchSkills = useCallback(async () => {
    try {
      if (isRemote) {
        const res = await fetch("/api/remote/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connection_id: remoteConnectionId,
            engine_type: engineType,
            action: "list",
            cwd: workingDirectory || undefined,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          setSkills(data.skills || []);
        }
      } else {
        const params = new URLSearchParams();
        params.set("engine_type", engineType);
        if (workingDirectory) {
          params.set("cwd", workingDirectory);
        }
        const qs = params.toString();
        const res = await fetch(`/api/skills${qs ? `?${qs}` : ""}`);
        if (res.ok) {
          const data = await res.json();
          setSkills(data.skills || []);
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [engineType, workingDirectory, isRemote, remoteConnectionId]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  useEffect(() => {
    const syncEngine = () => {
      setEngineType(readActiveEngine(buildEnginePreferenceTarget(workspaceMode, remoteConnectionId)));
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
    setSelected(null);
  }, [engineType]);

  const handleEngineSelect = useCallback((nextEngine: RuntimeEngine) => {
    setEngineType(nextEngine);
    persistEnginePreferences(nextEngine, {}, buildEnginePreferenceTarget(workspaceMode, remoteConnectionId));
    window.dispatchEvent(new Event("engine-changed"));
  }, [remoteConnectionId, workspaceMode]);

  const handleCreate = useCallback(
    async (
      name: string,
      scope: "global" | "project",
      createEngineType: RuntimeEngine,
      content: string
    ) => {
      if (isRemote) {
        const res = await fetch("/api/remote/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connection_id: remoteConnectionId,
            engine_type: createEngineType,
            action: "install",
            skill_name: name,
            skill_content: content,
            scope,
            cwd: workingDirectory || undefined,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to create skill");
        }
        // Refresh the list
        await fetchSkills();
      } else {
        const res = await fetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            content,
            scope,
            cwd: workingDirectory || undefined,
            engine_type: createEngineType,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to create skill");
        }
        const data = await res.json();
        setSkills((prev) => [...prev, data.skill]);
        setSelected(data.skill);
      }
    },
    [workingDirectory, isRemote, remoteConnectionId, fetchSkills]
  );

  const buildSkillUrl = useCallback((skill: SkillItem) => {
    const params = new URLSearchParams();
    params.set("engine_type", engineType);
    if (skill.source === "installed" && skill.installedSource) {
      params.set("source", skill.installedSource);
    }
    if (workingDirectory) {
      params.set("cwd", workingDirectory);
    }
    const qs = params.toString();
    return `/api/skills/${encodeURIComponent(skill.name)}${qs ? `?${qs}` : ""}`;
  }, [engineType, workingDirectory]);

  const handleSave = useCallback(
    async (skill: SkillItem, content: string) => {
      const res = await fetch(buildSkillUrl(skill), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save skill");
      }
      const data = await res.json();
      // Update in list
      setSkills((prev) =>
        prev.map((s) =>
          s.name === skill.name &&
          s.source === data.skill.source &&
          s.installedSource === data.skill.installedSource
            ? data.skill
            : s
        )
      );
      // Update selected
      setSelected(data.skill);
    },
    [buildSkillUrl]
  );

  const handleDelete = useCallback(
    async (skill: SkillItem) => {
      if (isRemote) {
        const res = await fetch("/api/remote/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connection_id: remoteConnectionId,
            engine_type: engineType,
            action: "uninstall",
            skill_name: skill.name,
            scope: skill.source === "project" ? "project" : "global",
            cwd: workingDirectory || undefined,
          }),
        });
        if (res.ok) {
          setSkills((prev) => prev.filter((s) => !(s.name === skill.name && s.source === skill.source)));
          if (selected?.name === skill.name && selected?.source === skill.source) setSelected(null);
        }
      } else {
        const res = await fetch(buildSkillUrl(skill), { method: "DELETE" });
        if (res.ok) {
          setSkills((prev) =>
            prev.filter(
              (s) =>
                !(
                  s.name === skill.name &&
                  s.source === skill.source &&
                  s.installedSource === skill.installedSource
                )
            )
          );
          if (
            selected?.name === skill.name &&
            selected?.source === skill.source &&
            selected?.installedSource === skill.installedSource
          ) {
            setSelected(null);
          }
        }
      }
    },
    [buildSkillUrl, selected, isRemote, remoteConnectionId, engineType, workingDirectory]
  );

  const filtered = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase())
  );

  const globalSkills = filtered.filter((s) => s.source === "global");
  const projectSkills = filtered.filter((s) => s.source === "project");
  const installedSkills = filtered.filter((s) => s.source === "installed");
  const pluginSkills = filtered.filter((s) => s.source === "plugin");
  const isGemini = engineType === "gemini";
  const titleText = isGemini ? t('skills.geminiTitle') : t('extensions.skills');
  const listTabLabel = isGemini ? t('skills.myCommands') : t('skills.mySkills');
  const createButtonLabel = isGemini ? t('skills.newCommand') : t('skills.newSkill');
  const searchPlaceholder = isGemini ? t('skills.searchCommands') : t('skills.searchSkills');
  const emptyListText = isGemini ? t('skills.noCommandsFound') : t('skills.noSkillsFound');
  const emptySelectionTitle = isGemini ? t('skills.noCommandSelected') : t('skills.noSelected');
  const emptySelectionText = isGemini ? t('skills.selectOrCreateCommand') : t('skills.selectOrCreate');

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">
          {t('skills.loadingSkills')}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
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
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-lg font-semibold">{titleText}</h3>
        <div className="flex items-center rounded-md border border-border p-0.5">
          <button
            className={cn(
              "px-3 py-1 text-xs font-medium rounded transition-colors",
              engineType === "claude"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => handleEngineSelect("claude")}
          >
            Claude
          </button>
          <button
            className={cn(
              "px-3 py-1 text-xs font-medium rounded transition-colors",
              engineType === "codex"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => handleEngineSelect("codex")}
          >
            Codex
          </button>
          <button
            className={cn(
              "px-3 py-1 text-xs font-medium rounded transition-colors",
              engineType === "gemini"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => handleEngineSelect("gemini")}
          >
            Gemini
          </button>
        </div>
        {/* Segmented control */}
        <div className="flex items-center bg-muted rounded-md p-0.5">
          <button
            className={cn(
              "px-3 py-1 text-xs font-medium rounded transition-colors",
              viewTab === "local"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setViewTab("local")}
          >
            {listTabLabel}
          </button>
          {!isGemini && (
            <button
              className={cn(
                "px-3 py-1 text-xs font-medium rounded transition-colors",
                viewTab === "marketplace"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setViewTab("marketplace")}
            >
              {t('skills.marketplace')}
            </button>
          )}
        </div>
        <div className="flex-1" />
        {viewTab === "local" && (
          <Button size="sm" onClick={() => setShowCreate(true)} className="gap-1">
            <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
            {createButtonLabel}
          </Button>
        )}
      </div>

      {/* Main content */}
      {viewTab === "marketplace" && !isGemini ? (
        <MarketplaceBrowser engineType={engineType} onInstalled={fetchSkills} />
      ) : (
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: skill list */}
        <div className="w-64 shrink-0 flex flex-col border border-border rounded-lg overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="relative">
              <HugeiconsIcon icon={Search01Icon} className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-7 h-8 text-sm"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="p-1">
              {globalSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    Global
                  </span>
                  {globalSkills.map((skill) => (
                    <SkillListItem
                      key={`${skill.source}:${skill.installedSource ?? "default"}:${skill.name}`}
                      skill={skill}
                      selected={
                        selected?.name === skill.name &&
                        selected?.source === skill.source &&
                        selected?.installedSource === skill.installedSource
                      }
                      onSelect={() => setSelected(skill)}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              {projectSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    Project
                  </span>
                  {projectSkills.map((skill) => (
                    <SkillListItem
                      key={`${skill.source}:${skill.installedSource ?? "default"}:${skill.name}`}
                      skill={skill}
                      selected={
                        selected?.name === skill.name &&
                        selected?.source === skill.source &&
                        selected?.installedSource === skill.installedSource
                      }
                      onSelect={() => setSelected(skill)}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              {installedSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    Installed
                  </span>
                  {installedSkills.map((skill) => (
                    <SkillListItem
                      key={`${skill.source}:${skill.installedSource ?? "default"}:${skill.name}`}
                      skill={skill}
                      selected={
                        selected?.name === skill.name &&
                        selected?.source === skill.source &&
                        selected?.installedSource === skill.installedSource
                      }
                      onSelect={() => setSelected(skill)}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              {pluginSkills.length > 0 && (
                <div className="mb-1">
                  <span className="px-3 py-1 text-[10px] font-medium uppercase text-muted-foreground">
                    Plugins
                  </span>
                  {pluginSkills.map((skill) => (
                    <SkillListItem
                      key={skill.filePath || `${skill.source}:${skill.installedSource ?? "default"}:${skill.name}`}
                      skill={skill}
                      selected={
                        selected?.name === skill.name &&
                        selected?.source === skill.source &&
                        selected?.installedSource === skill.installedSource
                      }
                      onSelect={() => setSelected(skill)}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              {filtered.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                  <HugeiconsIcon icon={ZapIcon} className="h-8 w-8 opacity-40" />
                  <p className="text-xs">
                    {emptyListText}
                  </p>
                  {!search && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setShowCreate(true)}
                      className="gap-1"
                    >
                      <HugeiconsIcon icon={PlusSignIcon} className="h-3 w-3" />
                      {createButtonLabel}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: editor */}
        <div className="flex-1 min-w-0 border border-border rounded-lg overflow-hidden">
          {selected ? (
            <SkillEditor
              key={`${selected.source}:${selected.name}`}
              skill={selected}
              onSave={handleSave}
              onDelete={handleDelete}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
              <HugeiconsIcon icon={ZapIcon} className="h-12 w-12 opacity-30" />
              <div className="text-center">
                <p className="text-sm font-medium">{emptySelectionTitle}</p>
                <p className="text-xs">
                  {emptySelectionText}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCreate(true)}
                className="gap-1"
              >
                <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
                {createButtonLabel}
              </Button>
            </div>
          )}
        </div>
      </div>
      )}

      <CreateSkillDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        defaultEngineType={engineType}
        onCreate={handleCreate}
      />
    </div>
  );
}
