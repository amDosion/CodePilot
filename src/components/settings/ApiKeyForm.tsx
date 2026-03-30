"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";

interface ApiKeyFormProps {
  engineType: string;
  onSave: () => void;
}

export function ApiKeyForm({ engineType, onSave }: ApiKeyFormProps) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError("");

    try {
      const res = await fetch("/api/cli-auth/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: engineType, api_key: apiKey.trim() }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to save API key");
      }

      setSaved(true);
      setApiKey("");
      setTimeout(() => {
        setSaved(false);
        onSave();
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save API key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <Input
          type={showKey ? "text" : "password"}
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setError("");
            setSaved(false);
          }}
          placeholder={t("cli.auth.apiKeyPlaceholder")}
          className="pr-16 font-mono text-sm"
        />
        <button
          type="button"
          onClick={() => setShowKey((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
        >
          {showKey ? "Hide" : "Show"}
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      <Button
        onClick={handleSave}
        disabled={!apiKey.trim() || saving}
        size="sm"
        variant="outline"
        className="w-full"
      >
        {saving ? (
          <>
            <HugeiconsIcon
              icon={Loading02Icon}
              className="h-3 w-3 animate-spin"
            />
            {t("provider.saving")}
          </>
        ) : saved ? (
          <span className="text-green-600 dark:text-green-400">
            {t("cli.auth.apiKeySaved")}
          </span>
        ) : (
          t("cli.auth.apiKeySave")
        )}
      </Button>
    </div>
  );
}
