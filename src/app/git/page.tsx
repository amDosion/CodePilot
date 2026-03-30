"use client";

import { GitPanel } from "@/components/git/GitPanel";
import { usePanel } from "@/hooks/usePanel";
import { useTranslation } from "@/hooks/useTranslation";

export default function GitPage() {
  const { sessionId, workspaceMode, workingDirectory, remoteConnectionId } = usePanel();
  const { t } = useTranslation();

  const workspaceLabel =
    workingDirectory
    || (workspaceMode === "remote" ? remoteConnectionId : "")
    || t("git.noWorkspace");

  return (
    <div className="flex h-full w-full flex-col overflow-auto bg-background p-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <div className="rounded-3xl border border-border/60 bg-card/80 p-6 shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border/60 pb-5">
          <h1 className="text-2xl font-semibold text-foreground">{t("git.title")}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("git.description")}</p>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <section className="rounded-2xl border border-border/60 bg-background/80 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              {t("git.workspaceMode")}
            </p>
            <p className="mt-2 text-base font-medium text-foreground">
              {workspaceMode === "remote" ? t("git.remoteMode") : t("git.localMode")}
            </p>
            <p className="mt-4 text-xs uppercase tracking-[0.2em] text-muted-foreground">
              {t("git.workspacePath")}
            </p>
            <p className="mt-2 break-all rounded-xl bg-muted/50 px-3 py-2 font-mono text-xs text-foreground">
              {workspaceLabel}
            </p>
          </section>

          <section className="rounded-2xl border border-border/60 bg-background/80 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              {t("git.localMode")}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{t("git.localPolicy")}</p>
            <p className="mt-5 text-xs uppercase tracking-[0.2em] text-muted-foreground">
              {t("git.remoteMode")}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{t("git.remotePolicy")}</p>
          </section>
        </div>
        </div>

        <GitPanel
          sessionId={sessionId || undefined}
          workingDirectory={workingDirectory}
          workspaceMode={workspaceMode}
          remoteConnectionId={remoteConnectionId}
        />
      </div>
    </div>
  );
}
