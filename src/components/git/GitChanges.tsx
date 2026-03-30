"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";
import { GitFileItem } from "./GitFileItem";
import type { GitFileStatus, GitStatus } from "@/types";

interface GitChangesProps {
  status: GitStatus;
  pendingAction: string | null;
  selectedDiffKey: string | null;
  onPreview: (file: GitFileStatus, mode: "staged" | "unstaged") => void;
  onStage: (file: GitFileStatus) => void;
  onUnstage: (file: GitFileStatus) => void;
  onStageAll: () => void;
}

function groupFiles(status: GitStatus) {
  const staged = status.files.filter((file) => file.index !== " " && file.index !== "?");
  const unstaged = status.files.filter((file) => file.working_dir !== " ");
  const untracked = status.files.filter((file) => file.index === "?" && file.working_dir === "?");

  return { staged, unstaged, untracked };
}

export function GitChanges({
  status,
  pendingAction,
  selectedDiffKey,
  onPreview,
  onStage,
  onUnstage,
  onStageAll,
}: GitChangesProps) {
  const { t } = useTranslation();
  const { staged, unstaged, untracked } = groupFiles(status);
  const canStageAll = unstaged.length > 0 || untracked.length > 0;

  return (
    <Card className="gap-4">
      <CardHeader className="border-b">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>{t("git.changesTitle")}</CardTitle>
            <CardDescription>
              {status.clean ? t("git.noChanges") : `${status.files.length} ${t("git.changesCount")}`}
            </CardDescription>
          </div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onStageAll}
            disabled={!canStageAll || pendingAction === "stage-all"}
          >
            {t("git.stageAll")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.clean ? (
          <div className="rounded-2xl border border-dashed border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
            {t("git.noChanges")}
          </div>
        ) : (
          <ScrollArea className="h-[26rem]">
            <div className="space-y-4 pr-4">
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">{t("git.staged")}</h3>
                  <span className="text-xs text-muted-foreground">{staged.length}</span>
                </div>
                {staged.length ? (
                  staged.map((file) => (
                    <GitFileItem
                      key={`staged:${file.path}`}
                      file={file}
                      mode="staged"
                      active={selectedDiffKey === `staged:${file.path}`}
                      pending={pendingAction === `unstage:${file.path}`}
                      onPreview={onPreview}
                      onStage={onStage}
                      onUnstage={onUnstage}
                    />
                  ))
                ) : (
                  <div className="text-sm text-muted-foreground">{t("git.noStagedChanges")}</div>
                )}
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">{t("git.unstaged")}</h3>
                  <span className="text-xs text-muted-foreground">{unstaged.length}</span>
                </div>
                {unstaged.length ? (
                  unstaged.map((file) => (
                    <GitFileItem
                      key={`unstaged:${file.path}`}
                      file={file}
                      mode="unstaged"
                      active={selectedDiffKey === `unstaged:${file.path}`}
                      pending={pendingAction === `stage:${file.path}`}
                      onPreview={onPreview}
                      onStage={onStage}
                      onUnstage={onUnstage}
                    />
                  ))
                ) : (
                  <div className="text-sm text-muted-foreground">{t("git.noUnstagedChanges")}</div>
                )}
              </section>
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
