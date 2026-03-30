"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/hooks/useTranslation";

interface RemoteDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface RemotePathBrowserProps {
  connectionId: string;
  value: string;
  onChange: (path: string) => void;
}

export function RemotePathBrowser({ connectionId, value, onChange }: RemotePathBrowserProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const fetchEntries = useCallback(async (targetPath: string) => {
    if (!connectionId) return;
    setLoading(true);
    try {
      const res = await fetch("/api/remote/ls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: connectionId, path: targetPath }),
      });
      if (res.ok) {
        const data = await res.json();
        setCurrentPath(data.current_path || targetPath);
        setEntries(data.entries || []);
      }
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  const handleOpen = () => {
    setOpen(true);
    fetchEntries(value || "~");
  };

  const handleSelect = (path: string) => {
    onChange(path);
    localStorage.setItem("codepilot:last-remote-path", path);
    setOpen(false);
  };

  const handleNavigate = (path: string) => {
    fetchEntries(path);
  };

  const parentPath = currentPath.includes("/")
    ? currentPath.replace(/\/[^/]+$/, "") || "/"
    : "/";

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            localStorage.setItem("codepilot:last-remote-path", e.target.value);
          }}
          placeholder="/root/project"
          className="flex-1"
        />
        <Button variant="outline" size="sm" className="shrink-0" onClick={handleOpen}>
          {t("chat.remotePathBrowse")}
        </Button>
      </div>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-popover shadow-lg">
          <div className="border-b border-border/50 px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground truncate">
              {currentPath}
            </p>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {loading && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                {t("chat.remotePathLoading")}
              </div>
            )}
            {!loading && (
              <>
                {/* Select current directory */}
                <button
                  type="button"
                  onClick={() => handleSelect(currentPath)}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors border-b border-border/30 font-medium text-primary"
                >
                  {currentPath}
                </button>

                {/* Parent directory */}
                {currentPath !== "/" && (
                  <button
                    type="button"
                    onClick={() => handleNavigate(parentPath)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors border-b border-border/30 text-muted-foreground"
                  >
                    .. ({t("chat.remotePathParent")})
                  </button>
                )}

                {/* Subdirectories */}
                {entries.length === 0 && (
                  <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                    {t("chat.remotePathEmpty")}
                  </div>
                )}
                {entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => handleNavigate(entry.path)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors border-b border-border/30 last:border-b-0"
                  >
                    {entry.name}/
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
