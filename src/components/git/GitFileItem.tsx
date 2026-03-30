"use client";

import { FileDiff, Minus, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { GitFileStatus } from "@/types";

interface GitFileItemProps {
  file: GitFileStatus;
  mode: "staged" | "unstaged";
  active?: boolean;
  pending?: boolean;
  onPreview: (file: GitFileStatus, mode: "staged" | "unstaged") => void;
  onStage: (file: GitFileStatus) => void;
  onUnstage: (file: GitFileStatus) => void;
}

function getBadgeLabel(file: GitFileStatus): string {
  return `${file.index}${file.working_dir}`;
}

export function GitFileItem({
  file,
  mode,
  active = false,
  pending = false,
  onPreview,
  onStage,
  onUnstage,
}: GitFileItemProps) {
  const { t } = useTranslation();
  const actionLabel = mode === "staged" ? t("git.unstage") : t("git.stage");

  return (
    <div
      className={cn(
        "rounded-2xl border border-border/60 bg-background/70 p-3 transition-colors",
        active && "border-primary/60 bg-primary/5",
      )}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{getBadgeLabel(file)}</Badge>
            {file.staging ? <Badge variant="secondary">{file.staging}</Badge> : null}
          </div>
          <div className="break-all font-mono text-xs text-foreground">{file.path}</div>
          {file.original_path ? (
            <div className="break-all text-xs text-muted-foreground">
              {t("git.originalPath")}: {file.original_path}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onPreview(file, mode)}
            disabled={pending}
          >
            <FileDiff className="size-3.5" />
            {t("git.previewDiff")}
          </Button>
          <Button
            type="button"
            size="xs"
            onClick={() => (mode === "staged" ? onUnstage(file) : onStage(file))}
            disabled={pending}
          >
            {mode === "staged" ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
            {actionLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
