"use client";

import { useState, useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Copy01Icon, Tick01Icon, Loading02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePanel } from "@/hooks/usePanel";
import { useTranslation } from "@/hooks/useTranslation";
import { buildFilePreviewUrl } from "@/lib/file-preview-url";
import { CodeBlock } from "@/components/ai-elements/code-block";
import type { FilePreview as FilePreviewType } from "@/types";

interface FilePreviewProps {
  filePath: string;
  onBack: () => void;
}

function getRelativePath(rootPath: string, targetPath: string): string {
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedTarget = targetPath.replace(/\\/g, "/");
  if (!normalizedRoot) return normalizedTarget;
  if (normalizedTarget === normalizedRoot) return ".";
  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget.slice(normalizedRoot.length + 1);
  }
  return normalizedTarget;
}

export function FilePreview({ filePath, onBack }: FilePreviewProps) {
  const { workingDirectory, sessionId, workspaceMode, remoteConnectionId } = usePanel();
  const { t } = useTranslation();
  const [preview, setPreview] = useState<FilePreviewType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function loadPreview() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(buildFilePreviewUrl({
          filePath,
          sessionId,
          workingDirectory,
          workspaceMode,
          remoteConnectionId,
        }));
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || t('filePreview.failedToLoad'));
        }
        const data = await res.json();
        setPreview(data.preview);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('filePreview.failedToLoad'));
      } finally {
        setLoading(false);
      }
    }

    loadPreview();
  }, [filePath, remoteConnectionId, sessionId, t, workingDirectory, workspaceMode]);

  const handleCopyPath = async () => {
    await navigator.clipboard.writeText(getRelativePath(workingDirectory, filePath));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const relativePath = getRelativePath(workingDirectory, filePath);
  const segments = relativePath.split("/").filter(Boolean);
  const displaySegments = segments.slice(-3);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 pb-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <HugeiconsIcon icon={ArrowLeft01Icon} className="h-3.5 w-3.5" />
          <span className="sr-only">{t('filePreview.backToTree')}</span>
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">
            {displaySegments.length < segments.length && ".../"}{displaySegments.join("/")}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={handleCopyPath}>
          {copied ? (
            <HugeiconsIcon icon={Tick01Icon} className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <HugeiconsIcon icon={Copy01Icon} className="h-3.5 w-3.5" />
          )}
          <span className="sr-only">{t('filePreview.copyPath')}</span>
        </Button>
      </div>

      {preview && (
        <div className="flex items-center gap-2 pb-2">
          <Badge variant="secondary" className="text-[10px]">
            {preview.binary ? t("filePreview.binaryBadge") : preview.language}
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            {t('filePreview.lines', { count: preview.line_count })}
          </span>
          {preview.truncated ? (
            <Badge variant="outline" className="text-[10px]">
              {t("filePreview.truncated")}
            </Badge>
          ) : null}
        </div>
      )}

      <ScrollArea className="flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="py-4 text-center">
            <p className="text-xs text-destructive">{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="mt-2 text-xs"
            >
              {t('filePreview.backToTree')}
            </Button>
          </div>
        ) : preview?.binary ? (
          <div className="rounded-md border border-dashed border-border/60 px-4 py-6 text-center">
            <p className="text-sm font-medium text-foreground">{t("filePreview.binaryTitle")}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {t("filePreview.binaryDescription")}
            </p>
          </div>
        ) : preview ? (
          <div className="rounded-md border border-border text-xs">
            {preview.truncated ? (
              <div className="border-b border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                {t("filePreview.truncatedDescription")}
              </div>
            ) : null}
            <CodeBlock
              code={preview.content}
              language={preview.language}
              showLineNumbers
              className="rounded-none border-0 bg-transparent"
            >
              <div className="border-b border-border/60 bg-muted/20 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {preview.language}
              </div>
            </CodeBlock>
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}
