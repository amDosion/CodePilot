"use client";

import { GitBranch, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "@/hooks/useTranslation";
import type { WorkspaceMode } from "@/hooks/usePanel";
import type { GitStatus } from "@/types";

interface GitStatusBarProps {
  status: GitStatus;
  workspaceMode: WorkspaceMode;
  refreshing: boolean;
  onRefresh: () => void;
}

export function GitStatusBar({
  status,
  workspaceMode,
  refreshing,
  onRefresh,
}: GitStatusBarProps) {
  const { t } = useTranslation();

  return (
    <Card className="gap-4">
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{t("git.statusTitle")}</CardTitle>
            <CardDescription>{t("git.statusDescription")}</CardDescription>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
            {t("git.refresh")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {workspaceMode === "remote" ? t("git.remoteMode") : t("git.localMode")}
          </Badge>
          <Badge variant={status.clean ? "outline" : "secondary"}>
            {status.clean ? t("git.clean") : t("git.dirty")}
          </Badge>
          <Badge variant="outline">
            <GitBranch className="size-3.5" />
            {status.branch || "HEAD"}
          </Badge>
          {status.tracking ? (
            <Badge variant="outline">
              {t("git.tracking")}: {status.tracking}
            </Badge>
          ) : null}
          {status.ahead > 0 || status.behind > 0 ? (
            <Badge variant="outline">
              {t("git.aheadBehind", { ahead: status.ahead, behind: status.behind })}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t("git.staged")}: {status.staged_count}</span>
          <span>{t("git.unstaged")}: {status.unstaged_count}</span>
          <span>{t("git.untracked")}: {status.untracked_count}</span>
        </div>
      </CardContent>
    </Card>
  );
}
