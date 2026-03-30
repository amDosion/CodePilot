"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import { ReloadIcon, Loading02Icon } from "@hugeicons/core-free-icons";
import { useUpdate } from "@/hooks/useUpdate";
import { useTranslation } from "@/hooks/useTranslation";
import { SUPPORTED_LOCALES, type Locale } from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const UPDATE_SNOOZED_UNTIL_KEY = "codepilot_update_snoozed_until";
type UpdateCheckFrequency = 'daily' | 'weekly' | 'monthly' | 'never';

function isValidFrequency(v: unknown): v is UpdateCheckFrequency {
  return v === 'daily' || v === 'weekly' || v === 'monthly' || v === 'never';
}

/** Save update settings to DB and sync to localStorage cache for AppShell */
async function saveUpdateSettings(key: 'update_check_frequency' | 'update_dialog_enabled', value: string) {
  // Sync to localStorage immediately so AppShell picks it up without another API call
  localStorage.setItem(`codepilot:${key}`, value);
  try {
    await fetch("/api/settings/app", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { [key]: value } }),
    });
  } catch {
    // ignore
  }
}

function UpdateCard() {
  const { updateInfo, checking, checkForUpdates, downloadUpdate, quitAndInstall, setShowDialog } = useUpdate();
  const { t } = useTranslation();
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";

  const [checkFrequency, setCheckFrequency] = useState<UpdateCheckFrequency>('daily');
  const [dialogEnabled, setDialogEnabled] = useState(true);

  // Load settings from DB on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings/app");
        if (res.ok) {
          const data = await res.json();
          const s = data.settings || {};
          const freq = isValidFrequency(s.update_check_frequency) ? s.update_check_frequency : 'daily';
          const enabled = s.update_dialog_enabled !== 'false';
          setCheckFrequency(freq);
          setDialogEnabled(enabled);
          // Sync to localStorage cache for AppShell
          localStorage.setItem('codepilot:update_check_frequency', freq);
          localStorage.setItem('codepilot:update_dialog_enabled', enabled ? 'true' : 'false');
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  const handleFrequencyChange = (value: string) => {
    const freq = value as UpdateCheckFrequency;
    setCheckFrequency(freq);
    void saveUpdateSettings('update_check_frequency', freq);
    // When user changes frequency (not to "never"), trigger an immediate check
    if (freq !== 'never') {
      checkForUpdates();
    }
  };

  const handleDialogToggle = (enabled: boolean) => {
    setDialogEnabled(enabled);
    void saveUpdateSettings('update_dialog_enabled', enabled ? 'true' : 'false');
    // If re-enabling, also clear any snooze
    if (enabled) {
      localStorage.removeItem(UPDATE_SNOOZED_UNTIL_KEY);
    }
  };

  const isDownloading = updateInfo?.isNativeUpdate && !updateInfo.readyToInstall
    && updateInfo.downloadProgress != null;

  return (
    <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">{t('settings.codepilot')}</h2>
          <p className="text-xs text-muted-foreground">{t('settings.version', { version: currentVersion })}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Show install/restart button when update available */}
          {updateInfo?.updateAvailable && !checking && (
            updateInfo.readyToInstall ? (
              <Button size="sm" onClick={quitAndInstall}>
                {t('update.restartToUpdate')}
              </Button>
            ) : updateInfo.isNativeUpdate && !isDownloading ? (
              <Button size="sm" onClick={downloadUpdate}>
                {t('update.installUpdate')}
              </Button>
            ) : !updateInfo.isNativeUpdate ? (
              <Button size="sm" variant="outline" onClick={() => window.open(updateInfo.releaseUrl, "_blank")}>
                {t('settings.viewRelease')}
              </Button>
            ) : null
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={checkForUpdates}
            disabled={checking}
            className="gap-2"
          >
            {checking ? (
              <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <HugeiconsIcon icon={ReloadIcon} className="h-3.5 w-3.5" />
            )}
            {checking ? t('settings.checking') : t('settings.checkForUpdates')}
          </Button>
        </div>
      </div>

      {updateInfo && !checking && (
        <div className="mt-3">
          {updateInfo.updateAvailable ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${updateInfo.readyToInstall ? 'bg-green-500' : isDownloading ? 'bg-yellow-500 animate-pulse' : 'bg-blue-500'}`} />
                <span className="text-sm">
                  {updateInfo.readyToInstall
                    ? t('update.readyToInstall', { version: updateInfo.latestVersion })
                    : isDownloading
                      ? `${t('update.downloading')} ${Math.round(updateInfo.downloadProgress!)}%`
                      : t('settings.updateAvailable', { version: updateInfo.latestVersion })}
                </span>
                {updateInfo.releaseNotes && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs text-muted-foreground"
                    onClick={() => setShowDialog(true)}
                  >
                    {t('gallery.viewDetails')}
                  </Button>
                )}
              </div>
              {/* Download progress bar */}
              {isDownloading && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all"
                    style={{ width: `${Math.min(updateInfo.downloadProgress!, 100)}%` }}
                  />
                </div>
              )}
              {updateInfo.lastError && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {updateInfo.lastError}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('settings.latestVersion')}</p>
          )}
        </div>
      )}

      {/* Check frequency and dialog settings */}
      <div className="mt-4 space-y-3 border-t border-border/50 pt-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t('update.checkFrequency')}</p>
            <p className="text-xs text-muted-foreground">{t('update.checkFrequencyDesc')}</p>
          </div>
          <Select value={checkFrequency} onValueChange={handleFrequencyChange}>
            <SelectTrigger className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">{t('update.frequencyDaily')}</SelectItem>
              <SelectItem value="weekly">{t('update.frequencyWeekly')}</SelectItem>
              <SelectItem value="monthly">{t('update.frequencyMonthly')}</SelectItem>
              <SelectItem value="never">{t('update.frequencyNever')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t('update.dialogEnabled')}</p>
            <p className="text-xs text-muted-foreground">{t('update.dialogEnabledDesc')}</p>
          </div>
          <Switch
            checked={dialogEnabled}
            onCheckedChange={handleDialogToggle}
          />
        </div>
      </div>
    </div>
  );
}

export function GeneralSection() {
  const router = useRouter();
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [showSkipPermWarning, setShowSkipPermWarning] = useState(false);
  const [skipPermSaving, setSkipPermSaving] = useState(false);
  const [authName, setAuthName] = useState("");
  const [authLoading, setAuthLoading] = useState(true);
  const [logoutPending, setLogoutPending] = useState(false);
  const { t, locale, setLocale } = useTranslation();

  const fetchAppSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/app");
      if (res.ok) {
        const data = await res.json();
        const appSettings = data.settings || {};
        setSkipPermissions(appSettings.dangerously_skip_permissions === "true");
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchAuthSession = useCallback(async () => {
    setAuthLoading(true);
    try {
      const res = await fetch("/api/auth/session", {
        credentials: "include",
        cache: "no-store",
      });

      if (res.status === 401) {
        router.replace("/login");
        return;
      }

      if (res.ok) {
        const data = await res.json();
        const user = data.user || {};
        setAuthName(user.displayName || user.username || "");
      }
    } catch {
      // ignore
    } finally {
      setAuthLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchAppSettings();
    fetchAuthSession();
  }, [fetchAppSettings, fetchAuthSession]);

  const handleSkipPermToggle = (checked: boolean) => {
    if (checked) {
      setShowSkipPermWarning(true);
    } else {
      saveSkipPermissions(false);
    }
  };

  const saveSkipPermissions = async (enabled: boolean) => {
    setSkipPermSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { dangerously_skip_permissions: enabled ? "true" : "" },
        }),
      });
      if (res.ok) {
        setSkipPermissions(enabled);
      }
    } catch {
      // ignore
    } finally {
      setSkipPermSaving(false);
      setShowSkipPermWarning(false);
    }
  };

  const handleLogout = async () => {
    setLogoutPending(true);
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // ignore
    } finally {
      router.replace("/login");
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <UpdateCard />

      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">{t('settings.authTitle')}</h2>
            <p className="text-xs text-muted-foreground">
              {authLoading
                ? t('settings.authChecking')
                : t('settings.authSignedInAs', { name: authName || t('settings.authUnknownUser') })}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleLogout}
            disabled={authLoading || logoutPending}
          >
            {logoutPending ? t('settings.authSigningOut') : t('settings.authSignOut')}
          </Button>
        </div>
      </div>

      {/* Auto-approve toggle */}
      <div className={`rounded-lg border p-4 transition-shadow hover:shadow-sm ${skipPermissions ? "border-orange-500/50 bg-orange-500/5" : "border-border/50"}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">{t('settings.autoApproveTitle')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('settings.autoApproveDesc')}
            </p>
          </div>
          <Switch
            checked={skipPermissions}
            onCheckedChange={handleSkipPermToggle}
            disabled={skipPermSaving}
          />
        </div>
        {skipPermissions && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-orange-500/10 px-3 py-2 text-xs text-orange-600 dark:text-orange-400">
            <span className="h-2 w-2 shrink-0 rounded-full bg-orange-500" />
            {t('settings.autoApproveWarning')}
          </div>
        )}
      </div>

      {/* Language picker */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">{t('settings.language')}</h2>
            <p className="text-xs text-muted-foreground">{t('settings.languageDesc')}</p>
          </div>
          <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LOCALES.map((l) => (
                <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Skip-permissions warning dialog */}
      <AlertDialog open={showSkipPermWarning} onOpenChange={setShowSkipPermWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.autoApproveDialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {t('settings.autoApproveDialogDesc')}
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>{t('settings.autoApproveShellCommands')}</li>
                  <li>{t('settings.autoApproveFileOps')}</li>
                  <li>{t('settings.autoApproveNetwork')}</li>
                </ul>
                <p className="font-medium text-orange-600 dark:text-orange-400">
                  {t('settings.autoApproveTrustWarning')}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => saveSkipPermissions(true)}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              {t('settings.enableAutoApprove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
