"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshIcon, Search01Icon, SourceCodeIcon, CodeIcon, File01Icon } from "@hugeicons/core-free-icons";
import { Copy, ExternalLink, MoreHorizontal, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FileTreeNode } from "@/types";
import type { TranslationKey } from "@/i18n";
import {
  FileTree as AIFileTree,
  FileTreeFolder,
  FileTreeFile,
} from "@/components/ai-elements/file-tree";
import { FileUploadDialog } from "@/components/project/FileUploadDialog";
import { useTranslation } from "@/hooks/useTranslation";
import type { WorkspaceMode } from "@/hooks/usePanel";
import type { ReactNode } from "react";

interface FileTreeProps {
  workingDirectory: string;
  sessionId?: string | null;
  onFileSelect: (path: string) => void;
  onFileAdd?: (path: string) => void;
  workspaceMode?: WorkspaceMode;
  remoteConnectionId?: string;
}

function getFileIcon(extension?: string): ReactNode {
  switch (extension) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "rb":
    case "rs":
    case "go":
    case "java":
    case "c":
    case "cpp":
    case "h":
    case "hpp":
    case "cs":
    case "swift":
    case "kt":
    case "dart":
    case "lua":
    case "php":
    case "zig":
      return <HugeiconsIcon icon={SourceCodeIcon} className="size-4 text-muted-foreground" />;
    case "json":
    case "yaml":
    case "yml":
    case "toml":
      return <HugeiconsIcon icon={CodeIcon} className="size-4 text-muted-foreground" />;
    case "md":
    case "mdx":
    case "txt":
    case "csv":
      return <HugeiconsIcon icon={File01Icon} className="size-4 text-muted-foreground" />;
    default:
      return <HugeiconsIcon icon={File01Icon} className="size-4 text-muted-foreground" />;
  }
}

function containsMatch(node: FileTreeNode, query: string): boolean {
  const q = query.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;
  if (node.children) {
    return node.children.some((child) => containsMatch(child, q));
  }
  return false;
}

function filterTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  if (!query) return nodes;
  return nodes
    .filter((node) => containsMatch(node, query))
    .map((node) => ({
      ...node,
      children: node.children ? filterTree(node.children, query) : undefined,
    }));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function getRelativePath(rootPath: string, targetPath: string): string {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedTarget = normalizePath(targetPath);
  if (!normalizedRoot) return targetPath;
  if (normalizedTarget === normalizedRoot) return ".";
  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget.slice(normalizedRoot.length + 1);
  }
  return targetPath;
}

interface RenderTreeNodesProps {
  nodes: FileTreeNode[];
  searchQuery: string;
  workingDirectory: string;
  workspaceMode?: WorkspaceMode;
  onUploadToDirectory: (targetDir: string) => void;
  onCopyPath: (value: string) => Promise<void>;
  onOpenPath: (value: string) => Promise<void>;
  t: (key: TranslationKey) => string;
}

function RenderTreeNodes({
  nodes,
  searchQuery,
  workingDirectory,
  workspaceMode,
  onUploadToDirectory,
  onCopyPath,
  onOpenPath,
  t,
}: RenderTreeNodesProps) {
  const filtered = searchQuery ? filterTree(nodes, searchQuery) : nodes;
  const canOpenInSystem = workspaceMode === "local";

  return (
    <>
      {filtered.map((node) => {
        const relativePath = getRelativePath(workingDirectory, node.path);
        const menuButtonClassName =
          node.type === "directory"
            ? "flex size-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover/folder:opacity-100"
            : "flex size-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover/file:opacity-100";
        const actions = (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={menuButtonClassName}
                aria-label={t("fileTree.moreActions")}
                title={t("fileTree.moreActions")}
              >
                <MoreHorizontal className="size-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {node.type === "directory" ? (
                <DropdownMenuItem onClick={() => onUploadToDirectory(node.path)}>
                  <Upload className="size-3.5" />
                  {t("fileTree.uploadHere")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => void onCopyPath(relativePath)}>
                <Copy className="size-3.5" />
                {t("fileTree.copyRelativePath")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void onCopyPath(node.path)}>
                <Copy className="size-3.5" />
                {t("fileTree.copyAbsolutePath")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void onOpenPath(node.path)}
                disabled={!canOpenInSystem}
              >
                <ExternalLink className="size-3.5" />
                {t("fileTree.openInSystem")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );

        if (node.type === "directory") {
          return (
            <FileTreeFolder
              key={node.path}
              path={node.path}
              name={node.name}
              tooltip={relativePath}
              actions={actions}
            >
              {node.children && (
                <RenderTreeNodes
                  nodes={node.children}
                  searchQuery={searchQuery}
                  workingDirectory={workingDirectory}
                  workspaceMode={workspaceMode}
                  onUploadToDirectory={onUploadToDirectory}
                  onCopyPath={onCopyPath}
                  onOpenPath={onOpenPath}
                  t={t}
                />
              )}
            </FileTreeFolder>
          );
        }
        return (
          <FileTreeFile
            key={node.path}
            path={node.path}
            name={node.name}
            icon={getFileIcon(node.extension)}
            tooltip={relativePath}
            actions={actions}
            addLabel={t("fileTree.addToChat")}
          />
        );
      })}
    </>
  );
}

export function FileTree({
  workingDirectory,
  sessionId,
  onFileSelect,
  onFileAdd,
  workspaceMode,
  remoteConnectionId,
}: FileTreeProps) {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadTargetDir, setUploadTargetDir] = useState("");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchTree = useCallback(async () => {
    if (!workingDirectory) {
      setTree([]);
      return;
    }
    setLoading(true);
    try {
      // Remote mode: fetch file tree via SSH
      if (workspaceMode === 'remote') {
        if (!remoteConnectionId) {
          setTree([]);
          return;
        }
        const res = await fetch('/api/remote/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connection_id: remoteConnectionId,
            path: workingDirectory,
            depth: 3,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          setTree(data.tree || []);
        } else {
          setTree([]);
        }
        return;
      }

      // Local mode: existing behavior
      const params = new URLSearchParams({
        dir: workingDirectory,
        depth: '4',
        _t: Date.now().toString(),
      });
      if (sessionId) {
        params.set('session_id', sessionId);
      } else {
        params.set('baseDir', workingDirectory);
      }
      const res = await fetch(`/api/files?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setTree(data.tree || []);
      } else {
        setTree([]);
      }
    } catch {
      setTree([]);
    } finally {
      setLoading(false);
    }
  }, [remoteConnectionId, sessionId, workingDirectory, workspaceMode]);

  const handleCopyPath = useCallback(async (value: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // clipboard access is best-effort
    }
  }, []);

  const handleOpenPath = useCallback(async (targetPath: string) => {
    if (workspaceMode !== "local") return;

    if (typeof window !== "undefined" && window.electronAPI?.shell?.openPath) {
      await window.electronAPI.shell.openPath(targetPath);
      return;
    }

    const body: Record<string, string> = { path: targetPath };
    if (sessionId) {
      body.session_id = sessionId;
    } else {
      body.baseDir = workingDirectory;
    }

    await fetch("/api/files/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }, [sessionId, workingDirectory, workspaceMode]);

  const openUploadDialog = useCallback((targetDir: string, files: File[]) => {
    if (files.length === 0) return;
    setUploadTargetDir(targetDir);
    setUploadFiles(files);
    setUploadDialogOpen(true);
  }, []);

  const requestFileSelection = useCallback((targetDir: string) => {
    setUploadTargetDir(targetDir);
    if (!fileInputRef.current) return;
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  }, []);

  const handleUploadSelection = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      openUploadDialog(uploadTargetDir || workingDirectory, files);
    },
    [openUploadDialog, uploadTargetDir, workingDirectory],
  );

  const handleDialogComplete = useCallback(() => {
    fetchTree();
    window.dispatchEvent(new Event("refresh-file-tree"));
  }, [fetchTree]);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.currentTarget === event.target) {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files || []);
    openUploadDialog(workingDirectory, files);
  }, [openUploadDialog, workingDirectory]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  useEffect(() => {
    const handler = () => fetchTree();
    window.addEventListener('refresh-file-tree', handler);
    return () => window.removeEventListener('refresh-file-tree', handler);
  }, [fetchTree]);

  const defaultExpanded = new Set<string>();
  const canUpload = useMemo(
    () => workspaceMode !== "remote" || Boolean(remoteConnectionId),
    [remoteConnectionId, workspaceMode],
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleUploadSelection}
      />
      <div className="flex items-center gap-1.5 px-4 py-2 shrink-0">
        <div className="relative flex-1 min-w-0">
          <HugeiconsIcon icon={Search01Icon} className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            placeholder={t('fileTree.filterFiles')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={fetchTree}
          disabled={loading}
          className="h-7 w-7 shrink-0"
        >
          <HugeiconsIcon icon={RefreshIcon} className={cn("h-3 w-3", loading && "animate-spin")} />
          <span className="sr-only">{t('fileTree.refresh')}</span>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!workingDirectory || !canUpload}
          onClick={() => requestFileSelection(workingDirectory)}
          className="h-7 w-7 shrink-0"
        >
          <Upload className="h-3.5 w-3.5" />
          <span className="sr-only">{t("fileTree.upload")}</span>
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {loading && tree.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <HugeiconsIcon icon={RefreshIcon} className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : tree.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {workingDirectory ? t('fileTree.noFiles') : t('fileTree.selectFolder')}
          </p>
        ) : (
          <AIFileTree
            defaultExpanded={defaultExpanded}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI Elements FileTree onSelect type conflicts with HTMLAttributes.onSelect
            onSelect={onFileSelect as any}
            onAdd={onFileAdd}
            className="border-0 rounded-none"
          >
            <RenderTreeNodes
              nodes={tree}
              searchQuery={searchQuery}
              workingDirectory={workingDirectory}
              workspaceMode={workspaceMode}
              onUploadToDirectory={requestFileSelection}
              onCopyPath={handleCopyPath}
              onOpenPath={handleOpenPath}
              t={t}
            />
          </AIFileTree>
        )}
      </div>

      {dragActive ? (
        <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-background/90">
          <div className="flex items-center gap-2 rounded-full bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
            <Upload className="size-4" />
            {t("fileTree.dropFiles")}
          </div>
        </div>
      ) : null}

      <FileUploadDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        files={uploadFiles}
        targetDir={uploadTargetDir || workingDirectory}
        workingDirectory={workingDirectory}
        workspaceMode={workspaceMode || "local"}
        remoteConnectionId={remoteConnectionId || ""}
        sessionId={sessionId}
        onComplete={handleDialogComplete}
      />
    </div>
  );
}
