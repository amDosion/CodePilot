"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslation } from "@/hooks/useTranslation";
import type { WorkspaceMode } from "@/hooks/usePanel";
import type { FileUploadResponse } from "@/types";

type UploadStatus = "queued" | "uploading" | "uploaded" | "conflict" | "error";

interface UploadItem {
  id: string;
  file: File;
  relativePath: string;
  status: UploadStatus;
  message?: string;
}

interface FileUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: File[];
  targetDir: string;
  workingDirectory: string;
  workspaceMode: WorkspaceMode;
  remoteConnectionId: string;
  sessionId?: string | null;
  onComplete?: () => void;
}

function getRelativeUploadPath(file: File): string {
  const webkitRelativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return webkitRelativePath || file.name;
}

function isConflictError(message: string): boolean {
  return message.toLowerCase().includes("already exists");
}

export function FileUploadDialog({
  open,
  onOpenChange,
  files,
  targetDir,
  workingDirectory,
  workspaceMode,
  remoteConnectionId,
  sessionId,
  onComplete,
}: FileUploadDialogProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [phaseMessage, setPhaseMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setUploading(false);
      setPhaseMessage("");
      setItems(
        files.map((file, index) => ({
          id: `${file.name}-${index}-${file.size}`,
          file,
          relativePath: getRelativeUploadPath(file),
          status: "queued",
        })),
      );
    });
  }, [files, open]);

  const queuedIndexes = useMemo(
    () => items.flatMap((item, index) => (item.status === "queued" ? [index] : [])),
    [items],
  );
  const conflictIndexes = useMemo(
    () => items.flatMap((item, index) => (item.status === "conflict" ? [index] : [])),
    [items],
  );
  const targetLabel = useMemo(() => {
    const normalizedRoot = workingDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedTarget = targetDir.replace(/\\/g, "/");
    if (!normalizedRoot) return normalizedTarget;
    if (normalizedTarget === normalizedRoot) return ".";
    if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
      return normalizedTarget.slice(normalizedRoot.length + 1);
    }
    return normalizedTarget;
  }, [targetDir, workingDirectory]);

  const setItemState = (index: number, status: UploadStatus, message?: string) => {
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, status, message } : item,
      ),
    );
  };

  const uploadSingleItem = async (item: UploadItem, overwrite: boolean) => {
    const endpoint =
      workspaceMode === "remote" ? "/api/remote/files/upload" : "/api/files/upload";
    const formData = new FormData();
    formData.append("files", item.file);
    formData.append("relative_paths", item.relativePath);
    formData.append("target_dir", targetDir);
    if (overwrite) {
      formData.append("overwrite", "true");
    }

    if (workspaceMode === "remote") {
      formData.append("connection_id", remoteConnectionId);
    } else if (sessionId) {
      formData.append("session_id", sessionId);
    } else {
      formData.append("baseDir", workingDirectory);
    }

    const response = await fetch(endpoint, {
      method: "POST",
      body: formData,
    });
    const data = (await response.json()) as FileUploadResponse | { error?: string };
    if (!response.ok) {
      const message = "error" in data ? data.error : undefined;
      throw new Error(message || t("fileTree.uploadFailed"));
    }

    const uploadResult = data as FileUploadResponse;
    if (uploadResult.uploaded.length > 0) {
      return {
        status: "uploaded" as const,
        message: uploadResult.uploaded[0].path,
      };
    }

    const errorMessage = uploadResult.errors[0]?.error || t("fileTree.uploadFailed");
    return {
      status: isConflictError(errorMessage) ? ("conflict" as const) : ("error" as const),
      message: errorMessage,
    };
  };

  const runUpload = async (indexes: number[], overwrite: boolean) => {
    if (indexes.length === 0) return;
    if (workspaceMode === "remote" && !remoteConnectionId) {
      setPhaseMessage(t("fileTree.uploadMissingRemote"));
      return;
    }

    setUploading(true);
    setPhaseMessage(
      overwrite ? t("fileTree.uploadOverwriting") : t("fileTree.uploadStarting"),
    );

    let completedAny = false;
    for (const index of indexes) {
      const item = items[index];
      if (!item) continue;
      setItemState(index, "uploading");
      setPhaseMessage(
        t("fileTree.uploadProgress", {
          name: item.file.name,
          path: targetLabel,
        }),
      );

      try {
        const result = await uploadSingleItem(item, overwrite);
        setItemState(index, result.status, result.message);
        if (result.status === "uploaded") {
          completedAny = true;
        }
      } catch (error) {
        setItemState(
          index,
          "error",
          error instanceof Error ? error.message : t("fileTree.uploadFailed"),
        );
      }
    }

    setUploading(false);
    setPhaseMessage(t("fileTree.uploadFinished"));
    if (completedAny) {
      onComplete?.();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("fileTree.uploadDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t(
              workspaceMode === "remote"
                ? "fileTree.uploadDialogRemoteDescription"
                : "fileTree.uploadDialogLocalDescription",
              { path: targetLabel },
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">
            {workspaceMode === "remote" ? t("fileTree.uploadRemoteBadge") : t("fileTree.uploadLocalBadge")}
          </Badge>
          <span>{phaseMessage || t("fileTree.uploadReady")}</span>
        </div>

        <ScrollArea className="max-h-[45vh] rounded-md border">
          <div className="space-y-2 p-3">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.file.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.relativePath}</p>
                  {item.message ? (
                    <p className="mt-1 text-xs text-muted-foreground">{item.message}</p>
                  ) : null}
                </div>
                <StatusBadge status={item.status} />
              </div>
            ))}
            {items.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("fileTree.uploadNoFiles")}
              </p>
            ) : null}
          </div>
        </ScrollArea>

        <DialogFooter className="items-center justify-between sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            <span>{items.length} {t("fileTree.uploadCount")}</span>
          </div>
          <div className="flex items-center gap-2">
            {conflictIndexes.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                disabled={uploading}
                onClick={() => void runUpload(conflictIndexes, true)}
              >
                <AlertCircle className="mr-2 size-4" />
                {t("fileTree.uploadOverwrite")}
              </Button>
            ) : null}
            {queuedIndexes.length > 0 ? (
              <Button
                type="button"
                disabled={uploading}
                onClick={() => void runUpload(queuedIndexes, false)}
              >
                <Upload className="mr-2 size-4" />
                {t("fileTree.uploadStart")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              disabled={uploading}
              onClick={() => onOpenChange(false)}
            >
              {t("common.close")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusBadge({ status }: { status: UploadStatus }) {
  const { t } = useTranslation();

  if (status === "uploaded") {
    return (
      <Badge className="gap-1 bg-emerald-600/90 text-white hover:bg-emerald-600/90">
        <CheckCircle2 className="size-3.5" />
        {t("fileTree.uploadUploaded")}
      </Badge>
    );
  }

  if (status === "uploading") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="size-3.5 animate-spin" />
        {t("fileTree.uploadUploading")}
      </Badge>
    );
  }

  if (status === "conflict") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/60 text-amber-600">
        <AlertCircle className="size-3.5" />
        {t("fileTree.uploadConflict")}
      </Badge>
    );
  }

  if (status === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertCircle className="size-3.5" />
        {t("fileTree.uploadError")}
      </Badge>
    );
  }

  return <Badge variant="secondary">{t("fileTree.uploadQueued")}</Badge>;
}
