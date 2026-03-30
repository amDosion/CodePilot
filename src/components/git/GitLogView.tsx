"use client";

import { History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { GitLogEntry } from "@/types";

interface GitLogViewProps {
  entries: GitLogEntry[];
  selectedSha: string;
  loading: boolean;
  onSelectCommit: (entry: GitLogEntry) => void;
}

function formatCommitDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

export function GitLogView({
  entries,
  selectedSha,
  loading,
  onSelectCommit,
}: GitLogViewProps) {
  const { t } = useTranslation();

  return (
    <Card className="gap-4">
      <CardHeader className="border-b">
        <CardTitle>{t("git.historyTitle")}</CardTitle>
        <CardDescription>{t("git.historyDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {!entries.length ? (
          <div className="text-sm text-muted-foreground">{loading ? t("git.loadingHistory") : t("git.noHistory")}</div>
        ) : (
          <ScrollArea className="h-[20rem]">
            <div className="space-y-3 pr-4">
              {entries.map((entry) => (
                <button
                  key={entry.sha}
                  type="button"
                  className={cn(
                    "w-full rounded-2xl border border-border/60 bg-background/70 p-3 text-left transition-colors hover:bg-muted/40",
                    selectedSha === entry.sha && "border-primary/60 bg-primary/5",
                  )}
                  onClick={() => onSelectCommit(entry)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge variant="outline">{entry.short_sha}</Badge>
                      {entry.refs ? <Badge variant="secondary">{entry.refs}</Badge> : null}
                    </div>
                    <div className="text-xs text-muted-foreground">{formatCommitDate(entry.date)}</div>
                  </div>
                  <div className="mt-2 line-clamp-2 text-sm font-medium text-foreground">{entry.message}</div>
                  <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>{entry.author}</span>
                    <span className="inline-flex items-center gap-1">
                      <History className="size-3.5" />
                      {t("git.viewCommitDiff")}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
