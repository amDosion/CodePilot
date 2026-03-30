"use client";

import { useState, useCallback, useSyncExternalStore } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  Settings02Icon,
  CodeIcon,
} from "@hugeicons/core-free-icons";
import { Plug01Icon, Analytics02Icon, BubbleChatIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { GeneralSection } from "./GeneralSection";
import { ProviderManager } from "./ProviderManager";
import { CliSettingsSection } from "./CliSettingsSection";
import { UsageStatsSection } from "./UsageStatsSection";
import { RemoteDevSection } from "./RemoteDevSection";
import { useTranslation } from "@/hooks/useTranslation";
import { usePanel } from "@/hooks/usePanel";
import type { TranslationKey } from "@/i18n";

type Section = "general" | "providers" | "cli" | "remote" | "usage";

interface SidebarItem {
  id: Section;
  label: string;
  icon: IconSvgElement;
}

const sidebarItems: SidebarItem[] = [
  { id: "general", label: "General", icon: Settings02Icon },
  { id: "providers", label: "Providers", icon: Plug01Icon },
  { id: "cli", label: "CLI Runtime", icon: CodeIcon },
  { id: "remote", label: "Remote Dev", icon: BubbleChatIcon },
  { id: "usage", label: "Usage", icon: Analytics02Icon },
];

function getSectionFromHash(): Section {
  if (typeof window === "undefined") return "general";
  const hash = window.location.hash.replace("#", "");
  if (sidebarItems.some((item) => item.id === hash)) {
    return hash as Section;
  }
  return "general";
}

function subscribeToHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function SettingsLayout() {
  const hashSection = useSyncExternalStore(subscribeToHash, getSectionFromHash, () => "general" as Section);
  const [overrideSection, setOverrideSection] = useState<Section | null>(null);
  const activeSection = overrideSection ?? hashSection;
  const { t } = useTranslation();
  const { workspaceMode, remoteConnectionId } = usePanel();

  const settingsLabelKeys: Record<string, TranslationKey> = {
    General: 'settings.general',
    Providers: 'settings.providers',
    'CLI Runtime': 'settings.claudeCli',
    'Remote Dev': 'settings.remoteDev',
    Usage: 'settings.usage',
  };

  const handleSectionChange = useCallback((section: Section) => {
    setOverrideSection(section);
    window.history.replaceState(null, "", `/settings#${section}`);
    queueMicrotask(() => setOverrideSection(null));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/50 px-6 pt-4 pb-4">
        <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.description')}</p>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-52 shrink-0 flex-col gap-1 border-r border-border/50 p-3">
          {sidebarItems.map((item) => (
            <button
              key={item.id}
              onClick={() => handleSectionChange(item.id)}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors text-left",
                activeSection === item.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )}
            >
              <HugeiconsIcon icon={item.icon} className="h-4 w-4 shrink-0" />
              {t(settingsLabelKeys[item.label])}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-auto p-6">
          {activeSection === "general" && <GeneralSection />}
          {activeSection === "providers" && <ProviderManager workspaceMode={workspaceMode} remoteConnectionId={remoteConnectionId} />}
          {activeSection === "cli" && <CliSettingsSection workspaceMode={workspaceMode} remoteConnectionId={remoteConnectionId} />}
          {activeSection === "remote" && <RemoteDevSection />}
          {activeSection === "usage" && <UsageStatsSection workspaceMode={workspaceMode} remoteConnectionId={remoteConnectionId} />}
        </div>
      </div>
    </div>
  );
}
