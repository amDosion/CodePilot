"use client";

import { Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/hooks/useTranslation";

interface GitCommitFormProps {
  message: string;
  stagedCount: number;
  suggestionSummary: string;
  generating: boolean;
  committing: boolean;
  onMessageChange: (next: string) => void;
  onGenerate: () => void;
  onCommit: () => void;
}

export function GitCommitForm({
  message,
  stagedCount,
  suggestionSummary,
  generating,
  committing,
  onMessageChange,
  onGenerate,
  onCommit,
}: GitCommitFormProps) {
  const { t } = useTranslation();
  const hasStagedChanges = stagedCount > 0;

  return (
    <Card className="gap-4">
      <CardHeader className="border-b">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>{t("git.commitTitle")}</CardTitle>
            <CardDescription>{t("git.commitDescription")}</CardDescription>
          </div>
          <Badge variant={hasStagedChanges ? "secondary" : "outline"}>
            {stagedCount} {t("git.staged")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Textarea
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder={t("git.commitPlaceholder")}
          rows={4}
        />

        {suggestionSummary ? (
          <div className="rounded-2xl border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {t("git.suggestionSummary")}: {suggestionSummary}
          </div>
        ) : null}

        {!hasStagedChanges ? (
          <div className="text-sm text-muted-foreground">{t("git.noStagedChanges")}</div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onGenerate}
            disabled={!hasStagedChanges || generating || committing}
          >
            {generating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {t("git.generateMessage")}
          </Button>
          <Button
            type="button"
            onClick={onCommit}
            disabled={!hasStagedChanges || !message.trim() || generating || committing}
          >
            {committing ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("git.commit")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
