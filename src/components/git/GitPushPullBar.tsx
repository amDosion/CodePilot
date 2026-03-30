"use client";

import { ArrowDownToLine, ArrowUpToLine, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "@/hooks/useTranslation";
import type { WorkspaceMode } from "@/hooks/usePanel";

interface GitPushPullBarProps {
  workspaceMode: WorkspaceMode;
  disabled: boolean;
  pendingAction: string | null;
  onPush: () => void;
  onPull: () => void;
  onFetch: () => void;
}

function BusyIcon({ active }: { active: boolean }) {
  return active ? <Loader2 className="size-4 animate-spin" /> : null;
}

export function GitPushPullBar({
  workspaceMode,
  disabled,
  pendingAction,
  onPush,
  onPull,
  onFetch,
}: GitPushPullBarProps) {
  const { t } = useTranslation();

  return (
    <Card className="gap-4">
      <CardHeader className="border-b">
        <CardTitle>{t("git.actionsTitle")}</CardTitle>
        <CardDescription>
          {workspaceMode === "remote" ? t("git.remotePolicy") : t("git.localPolicy")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onPush} disabled={disabled || !!pendingAction}>
            <BusyIcon active={pendingAction === "push"} />
            {pendingAction !== "push" ? <ArrowUpToLine className="size-4" /> : null}
            {t("git.push")}
          </Button>
          <Button type="button" variant="outline" onClick={onPull} disabled={disabled || !!pendingAction}>
            <BusyIcon active={pendingAction === "pull"} />
            {pendingAction !== "pull" ? <ArrowDownToLine className="size-4" /> : null}
            {t("git.pull")}
          </Button>
          <Button type="button" variant="outline" onClick={onFetch} disabled={disabled || !!pendingAction}>
            <BusyIcon active={pendingAction === "fetch"} />
            {pendingAction !== "fetch" ? <Download className="size-4" /> : null}
            {t("git.fetch")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("git.syncManualHint")}</p>
      </CardContent>
    </Card>
  );
}
