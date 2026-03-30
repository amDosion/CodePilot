"use client";

import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/hooks/useTranslation";
import type { GitRemote } from "@/types";
import { useState } from "react";

interface GitRemoteManagerProps {
  remotes: GitRemote[];
  pendingAction: string | null;
  onAdd: (name: string, url: string) => Promise<boolean>;
  onRemove: (name: string) => void;
}

export function GitRemoteManager({
  remotes,
  pendingAction,
  onAdd,
  onRemove,
}: GitRemoteManagerProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  return (
    <Card className="gap-4">
      <CardHeader className="border-b">
        <CardTitle>{t("git.remotesTitle")}</CardTitle>
        <CardDescription>{t("git.remotesDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          {remotes.length ? (
            remotes.map((remote) => (
              <div
                key={remote.name}
                className="rounded-2xl border border-border/60 bg-background/70 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <div className="font-medium text-foreground">{remote.name}</div>
                    <div className="break-all text-xs text-muted-foreground">
                      {remote.fetch_url || remote.push_url}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => onRemove(remote.name)}
                    disabled={!!pendingAction}
                  >
                    {pendingAction === `remove-remote:${remote.name}` ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    {t("git.removeRemote")}
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <div className="text-sm text-muted-foreground">{t("git.noRemotes")}</div>
          )}
        </div>

        <div className="grid gap-3">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("git.remoteName")}
            disabled={!!pendingAction}
          />
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t("git.remoteUrl")}
            disabled={!!pendingAction}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void (async () => {
                const added = await onAdd(name, url);
                if (added) {
                  setName("");
                  setUrl("");
                }
              })();
            }}
            disabled={!name.trim() || !url.trim() || !!pendingAction}
          >
            {pendingAction === "add-remote" ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("git.addRemote")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
