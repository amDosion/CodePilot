"use client";

import { useCallback } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { StructureFolderIcon, PanelRightCloseIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePanel, type PanelContent } from "@/hooks/usePanel";
import { useTranslation } from "@/hooks/useTranslation";
import { FileTree } from "@/components/project/FileTree";
import { TaskList } from "@/components/project/TaskList";

interface RightPanelProps {
  width?: number;
}

const NON_PREVIEWABLE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "avif",
  "mp4", "mov", "avi", "mkv", "webm", "flv", "wmv",
  "mp3", "wav", "ogg", "flac", "aac", "wma",
  "zip", "tar", "gz", "rar", "7z", "bz2",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "exe", "dll", "so", "dylib", "bin", "dmg", "iso",
  "woff", "woff2", "ttf", "otf", "eot",
]);

export function RightPanel({ width }: RightPanelProps) {
  const {
    panelOpen,
    setPanelOpen,
    panelContent,
    setPanelContent,
    workingDirectory,
    sessionId,
    previewFile,
    setPreviewFile,
    workspaceMode,
    remoteConnectionId,
  } = usePanel();
  const { t } = useTranslation();

  const handleFileAdd = useCallback((path: string) => {
    window.dispatchEvent(new CustomEvent("attach-file-to-chat", { detail: { path } }));
  }, []);

  const handleFileSelect = useCallback((path: string) => {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    if (NON_PREVIEWABLE_EXTENSIONS.has(ext)) return;

    if (previewFile === path) {
      setPreviewFile(null);
      return;
    }
    setPreviewFile(path);
  }, [previewFile, setPreviewFile]);

  const handleTabChange = useCallback((value: string) => {
    setPanelContent(value as PanelContent);
  }, [setPanelContent]);

  if (!panelOpen) {
    return null;
  }

  return (
    <aside
      className="hidden h-full shrink-0 flex-col overflow-hidden bg-background pb-3 lg:flex"
      style={{ width: width ?? 288 }}
    >
      <Tabs
        value={panelContent}
        onValueChange={handleTabChange}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div className="flex h-12 shrink-0 items-center gap-3 px-4">
          <TabsList className="grid h-8 w-full grid-cols-2">
            <TabsTrigger value="tasks" className="text-xs">
              {t("panel.tasks")}
            </TabsTrigger>
            <TabsTrigger value="files" className="text-xs">
              {t("panel.files")}
            </TabsTrigger>
          </TabsList>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setPanelOpen(false)}
              >
                <HugeiconsIcon icon={PanelRightCloseIcon} className="h-4 w-4" />
                <span className="sr-only">{t("panel.closePanel")}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t("panel.closePanel")}</TooltipContent>
          </Tooltip>
        </div>

        <TabsContent value="tasks" className="mt-0 min-h-0 overflow-hidden px-3">
          <TaskList sessionId={sessionId} />
        </TabsContent>

        <TabsContent value="files" className="mt-0 min-h-0 overflow-hidden">
          <FileTree
            workingDirectory={workingDirectory}
            sessionId={sessionId}
            onFileSelect={handleFileSelect}
            onFileAdd={handleFileAdd}
            workspaceMode={workspaceMode}
            remoteConnectionId={remoteConnectionId}
          />
        </TabsContent>
      </Tabs>
    </aside>
  );
}
