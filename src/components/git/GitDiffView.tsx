"use client";

import { Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CodeBlock } from "@/components/chat/CodeBlock";
import { useTranslation } from "@/hooks/useTranslation";

interface GitDiffViewProps {
  title: string;
  diff: string;
  loading: boolean;
}

export function GitDiffView({ title, diff, loading }: GitDiffViewProps) {
  const { t } = useTranslation();

  return (
    <Card className="gap-4">
      <CardHeader className="border-b">
        <CardTitle>{title || t("git.diffTitle")}</CardTitle>
        <CardDescription>{t("git.diffDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex h-[28rem] items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : diff ? (
          <ScrollArea className="h-[28rem]">
            <div className="pr-4">
              <CodeBlock code={diff} language="diff" showLineNumbers={false} />
            </div>
          </ScrollArea>
        ) : (
          <div className="rounded-2xl border border-dashed border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
            {t("git.diffEmpty")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
