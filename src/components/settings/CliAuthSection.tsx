"use client";

import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, ReloadIcon } from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";
import { OAuthLoginButton } from "./OAuthLoginButton";
import { ApiKeyForm } from "./ApiKeyForm";
import { LogoutButton } from "./LogoutButton";

type CliAuthStatus = "authenticated" | "expired" | "not-configured" | "error";
type CliAuthMethod = "oauth" | "api-key" | "env-var" | "none";

interface CliAuthInfo {
  engine: string;
  status: CliAuthStatus;
  method: CliAuthMethod;
  account?: { email?: string; plan?: string };
  lastUpdated?: string;
  maskedKey?: string;
}

interface CliAuthSectionProps {
  engineType: string;
}

function StatusBadge({ status }: { status: CliAuthStatus }) {
  const { t } = useTranslation();

  const config: Record<CliAuthStatus, { label: string; className: string }> = {
    authenticated: {
      label: t("cli.auth.authenticated"),
      className: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
    },
    expired: {
      label: t("cli.auth.expired"),
      className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30",
    },
    "not-configured": {
      label: t("cli.auth.notConfigured"),
      className: "bg-muted text-muted-foreground border-border",
    },
    error: {
      label: "Error",
      className: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
    },
  };

  const { label, className } = config[status] ?? config["not-configured"];

  return (
    <Badge variant="outline" className={className}>
      <span
        className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
          status === "authenticated"
            ? "bg-green-500"
            : status === "expired"
              ? "bg-yellow-500"
              : status === "error"
                ? "bg-red-500"
                : "bg-muted-foreground/50"
        }`}
      />
      {label}
    </Badge>
  );
}

function AuthenticatedView({
  authInfo,
  onLogout,
}: {
  authInfo: CliAuthInfo;
  onLogout: () => void;
}) {
  const { t } = useTranslation();

  const methodLabels: Record<CliAuthMethod, string> = {
    oauth: "OAuth",
    "api-key": "API Key",
    "env-var": "Environment Variable",
    none: "-",
  };

  return (
    <div className="space-y-3">
      <div className="rounded-md bg-muted/40 p-3 text-sm">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {authInfo.account?.email && (
            <>
              <span className="text-muted-foreground">{t("cli.auth.account")}</span>
              <span className="font-medium">{authInfo.account.email}</span>
            </>
          )}
          <span className="text-muted-foreground">{t("cli.auth.method")}</span>
          <span>{methodLabels[authInfo.method]}</span>
          {authInfo.maskedKey && (
            <>
              <span className="text-muted-foreground">{t("cli.auth.apiKey")}</span>
              <span className="font-mono text-xs">{authInfo.maskedKey}</span>
            </>
          )}
          {authInfo.lastUpdated && (
            <>
              <span className="text-muted-foreground">{t("cli.auth.lastUpdated")}</span>
              <span className="text-xs">
                {new Date(authInfo.lastUpdated).toLocaleString()}
              </span>
            </>
          )}
        </div>
      </div>

      <LogoutButton engineType={authInfo.engine} onLogout={onLogout} />
    </div>
  );
}

export function CliAuthSection({ engineType }: CliAuthSectionProps) {
  const { t } = useTranslation();
  const [authInfo, setAuthInfo] = useState<CliAuthInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAuthStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/cli-auth/status?engine=${engineType}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to fetch auth status");
      const data = (await res.json()) as {
        engines: Record<string, CliAuthInfo>;
      };
      const info = data.engines[engineType];
      if (info) {
        setAuthInfo(info);
      }
    } catch {
      setAuthInfo({
        engine: engineType,
        status: "error",
        method: "none",
      });
    } finally {
      setLoading(false);
    }
  }, [engineType]);

  useEffect(() => {
    setLoading(true);
    fetchAuthStatus();
  }, [fetchAuthStatus]);

  const refresh = useCallback(() => {
    fetchAuthStatus();
  }, [fetchAuthStatus]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border p-6">
        <HugeiconsIcon
          icon={Loading02Icon}
          className="h-4 w-4 animate-spin text-muted-foreground"
        />
        <span className="ml-2 text-sm text-muted-foreground">
          {t("cli.auth.status")}...
        </span>
      </div>
    );
  }

  const status = authInfo?.status ?? "not-configured";

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{t("cli.auth.title")}</h3>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={refresh}
            title="Refresh"
          >
            <HugeiconsIcon icon={ReloadIcon} className="h-3 w-3" />
          </Button>
        </div>
        <StatusBadge status={status} />
      </div>

      {status === "authenticated" && authInfo ? (
        <AuthenticatedView authInfo={authInfo} onLogout={refresh} />
      ) : (
        <div className="space-y-3">
          <OAuthLoginButton engineType={engineType} onComplete={refresh} />
          <div className="text-center text-xs text-muted-foreground">
            {t("cli.auth.orUseApiKey")}
          </div>
          <ApiKeyForm engineType={engineType} onSave={refresh} />
        </div>
      )}
    </div>
  );
}
