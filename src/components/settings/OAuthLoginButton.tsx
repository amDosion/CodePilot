"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";

type OAuthState =
  | "idle"
  | "starting"
  | "url_ready"
  | "exchanging"
  | "completed"
  | "failed";

interface OAuthLoginButtonProps {
  engineType: string;
  onComplete: () => void;
}

function getLoginLabel(engineType: string): string {
  switch (engineType) {
    case "claude":
      return "cli.auth.loginWithAnthropic";
    case "codex":
      return "cli.auth.loginWithChatGPT";
    case "gemini":
      return "cli.auth.loginWithGoogle";
    default:
      return "cli.auth.loginWithAnthropic";
  }
}

export function OAuthLoginButton({
  engineType,
  onComplete,
}: OAuthLoginButtonProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<OAuthState>("idle");
  const [loginUrl, setLoginUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef("");

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleStart = async () => {
    setState("starting");
    setErrorMessage("");
    setLoginUrl("");
    setCodeInput("");

    try {
      const res = await fetch("/api/cli-auth/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: engineType }),
      });
      if (!res.ok) throw new Error("start failed");
      const data = (await res.json()) as { session_id: string };
      sessionRef.current = data.session_id;

      // Poll for URL (should be immediate for Claude direct flow)
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(
            `/api/cli-auth/oauth/poll?session_id=${sessionRef.current}`,
          );
          if (!r.ok) return;
          const d = (await r.json()) as {
            status: string;
            auth_url?: string;
            error?: string;
          };

          if (d.status === "url_ready" && d.auth_url) {
            setLoginUrl(d.auth_url);
            setState("url_ready");
            stopPolling(); // URL is ready, stop polling
          } else if (d.status === "completed") {
            stopPolling();
            setState("completed");
            setTimeout(() => {
              setState("idle");
              onComplete();
            }, 1500);
          } else if (d.status === "failed") {
            stopPolling();
            setErrorMessage(d.error || t("cli.auth.loginFailed"));
            setState("failed");
          }
        } catch {
          /* retry */
        }
      }, 1000);
    } catch {
      setErrorMessage(t("cli.auth.loginFailed"));
      setState("failed");
    }
  };

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(loginUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* */
    }
  };

  const handleSubmitCode = async () => {
    const input = codeInput.trim();
    if (!input || !sessionRef.current) return;

    setState("exchanging");
    setErrorMessage("");

    try {
      const res = await fetch("/api/cli-auth/oauth/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionRef.current,
          code: input,
        }),
      });

      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
      };

      if (res.ok && data.success) {
        setState("completed");
        setTimeout(() => {
          setState("idle");
          onComplete();
        }, 1500);
      } else {
        setErrorMessage(data.error || t("cli.auth.loginFailed"));
        setState("url_ready"); // Let user retry
      }
    } catch {
      setErrorMessage(t("cli.auth.loginFailed"));
      setState("url_ready");
    }
  };

  const handleRetry = () => {
    stopPolling();
    setState("idle");
    setErrorMessage("");
    setLoginUrl("");
    setCodeInput("");
  };

  if (state === "idle") {
    return (
      <Button onClick={handleStart} className="w-full">
        {t(getLoginLabel(engineType) as Parameters<typeof t>[0])}
      </Button>
    );
  }

  if (state === "starting") {
    return (
      <Button disabled className="w-full">
        <HugeiconsIcon
          icon={Loading02Icon}
          className="h-4 w-4 animate-spin mr-2"
        />
        {t("cli.auth.initiating")}
      </Button>
    );
  }

  if (state === "url_ready") {
    return (
      <div className="space-y-3">
        {/* Step 1: Open login URL */}
        <p className="text-sm font-medium">
          {t("cli.auth.clickToLogin")}
        </p>
        <a
          href={loginUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono hover:bg-muted/60 transition-colors"
        >
          {loginUrl}
        </a>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyUrl}
            className="flex-1"
          >
            {copied ? "Copied!" : t("cli.auth.copyUrl")}
          </Button>
          <Button
            size="sm"
            className="flex-1"
            onClick={() => window.open(loginUrl, "_blank")}
          >
            {t("cli.auth.openBrowser")}
          </Button>
        </div>

        {/* Step 2: Paste code / redirect URL */}
        <div className="mt-2 border-t pt-3 space-y-2">
          <p className="text-sm text-muted-foreground">
            {t("cli.auth.enterCode")}
          </p>
          <Input
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            placeholder={t("cli.auth.codePlaceholder")}
            className="font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter" && codeInput.trim()) {
                handleSubmitCode();
              }
            }}
          />
          <Button
            onClick={handleSubmitCode}
            disabled={!codeInput.trim()}
            className="w-full"
            size="sm"
          >
            {t("cli.auth.submitCode")}
          </Button>
        </div>

        {/* Error from previous attempt */}
        {errorMessage && (
          <div className="rounded-md bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-400">
            {errorMessage}
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={handleRetry}
          className="w-full"
        >
          {t("common.cancel")}
        </Button>
      </div>
    );
  }

  if (state === "exchanging") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-md bg-blue-500/10 p-3 text-sm text-blue-700 dark:text-blue-400">
          <HugeiconsIcon
            icon={Loading02Icon}
            className="h-4 w-4 animate-spin"
          />
          <span>{t("cli.auth.verifying")}</span>
        </div>
      </div>
    );
  }

  if (state === "completed") {
    return (
      <div className="flex items-center gap-2 rounded-md bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">
        <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
        {t("cli.auth.loginSuccess")}
      </div>
    );
  }

  // failed
  return (
    <div className="space-y-2">
      <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-400">
        {errorMessage || t("cli.auth.loginFailed")}
      </div>
      <Button variant="outline" onClick={handleRetry} className="w-full">
        {t("cli.auth.retry")}
      </Button>
    </div>
  );
}
