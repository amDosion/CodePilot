"use client";

import { useState, useEffect, useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Copy01Icon, Tick01Icon, Loading02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { usePanel } from "@/hooks/usePanel";
import { useTranslation } from "@/hooks/useTranslation";
import { buildFilePreviewUrl } from "@/lib/file-preview-url";
import { getRenderedPreviewKind } from "@/lib/preview-support";
import { CodeBlock } from "@/components/ai-elements/code-block";
import type { FilePreview as FilePreviewType } from "@/types";

const streamdownPlugins = { cjk, code, math, mermaid };

type ViewMode = "source" | "rendered";

interface DocPreviewProps {
  filePath: string;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onClose: () => void;
  width: number;
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

export function DocPreview({
  filePath,
  viewMode,
  onViewModeChange,
  onClose,
  width,
}: DocPreviewProps) {
  const { workingDirectory, sessionId, workspaceMode, remoteConnectionId } = usePanel();
  const { t } = useTranslation();
  const [preview, setPreview] = useState<FilePreviewType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

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
          maxLines: 500,
        }));
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to load file");
        }
        const data = await res.json();
        if (!cancelled) {
          setPreview(data.preview);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load file");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadPreview();
    return () => {
      cancelled = true;
    };
  }, [filePath, remoteConnectionId, sessionId, workingDirectory, workspaceMode]);

  const handleCopyPath = async () => {
    await navigator.clipboard.writeText(getRelativePath(workingDirectory, filePath));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const fileName = filePath.split("/").pop() || filePath;

  // Build breadcrumb — show last 3 segments
  const breadcrumb = useMemo(() => {
    const segments = getRelativePath(workingDirectory, filePath).split("/").filter(Boolean);
    const display = segments.slice(-3);
    const prefix = display.length < segments.length ? ".../" : "";
    return prefix + display.join("/");
  }, [filePath, workingDirectory]);

  const renderedPreviewKind = getRenderedPreviewKind(filePath, preview?.language);
  const canRender = renderedPreviewKind !== null && !preview?.binary;

  return (
    <div
      className="hidden h-full shrink-0 flex-col overflow-hidden border-l border-border/40 bg-background lg:flex"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex h-12 mt-5 shrink-0 items-center gap-2 px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{fileName}</p>
        </div>

        {canRender && (
          <ViewModeToggle value={viewMode} onChange={onViewModeChange} />
        )}

        <Button variant="ghost" size="icon-sm" onClick={handleCopyPath}>
          {copied ? (
            <HugeiconsIcon icon={Tick01Icon} className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <HugeiconsIcon icon={Copy01Icon} className="h-3.5 w-3.5" />
          )}
          <span className="sr-only">{t("filePreview.copyPath")}</span>
        </Button>

        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <HugeiconsIcon icon={Cancel01Icon} className="h-3.5 w-3.5" />
          <span className="sr-only">Close preview</span>
        </Button>
      </div>

      {/* Breadcrumb + language — subtle, no border */}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/60">
          {breadcrumb}
        </p>
        {preview && (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[10px] text-muted-foreground/50">
              {preview.binary ? t("filePreview.binaryBadge") : preview.language}
            </span>
            {preview.truncated ? (
              <Badge variant="outline" className="text-[10px]">
                {t("filePreview.truncated")}
              </Badge>
            ) : null}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <HugeiconsIcon
              icon={Loading02Icon}
              className="h-5 w-5 animate-spin text-muted-foreground"
            />
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        ) : preview?.binary ? (
          <div className="px-6 py-8 text-center">
            <p className="text-sm font-medium text-foreground">{t("filePreview.binaryTitle")}</p>
            <p className="mt-2 text-sm text-muted-foreground">{t("filePreview.binaryDescription")}</p>
          </div>
        ) : preview ? (
          viewMode === "rendered" && canRender ? (
            <RenderedView content={preview.content} kind={renderedPreviewKind!} />
          ) : (
            <SourceView preview={preview} />
          )
        ) : null}
      </div>
    </div>
  );
}

/** Capsule toggle for Source / Preview view mode */
function ViewModeToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div className="flex h-6 items-center rounded-full bg-muted p-0.5 text-[11px]">
      <button
        className={`rounded-full px-2 py-0.5 font-medium transition-colors ${
          value === "source"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => onChange("source")}
      >
        Source
      </button>
      <button
        className={`rounded-full px-2 py-0.5 font-medium transition-colors ${
          value === "rendered"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => onChange("rendered")}
      >
        Preview
      </button>
    </div>
  );
}

/** Source code view using the shared Shiki-backed code block */
function SourceView({ preview }: { preview: FilePreviewType }) {
  const { t } = useTranslation();
  return (
    <div className="text-xs">
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
  );
}

/** Rendered view for markdown / HTML files */
function RenderedView({
  content,
  kind,
}: {
  content: string;
  kind: "markdown" | "html";
}) {
  const { t } = useTranslation();
  if (kind === "html") {
    return (
      <iframe
        srcDoc={content}
        sandbox=""
        className="h-full w-full border-0"
        title={t('docPreview.htmlPreview')}
      />
    );
  }

  // Markdown / MDX
  return (
    <div className="px-6 py-4 overflow-x-hidden break-words">
      <Streamdown
        className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-6 [&_ol]:pl-6"
        plugins={streamdownPlugins}
      >
        {content}
      </Streamdown>
    </div>
  );
}
