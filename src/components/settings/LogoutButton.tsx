"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
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
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";

interface LogoutButtonProps {
  engineType: string;
  onLogout: () => void;
}

export function LogoutButton({ engineType, onLogout }: LogoutButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);

  const handleLogout = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cli-auth/logout", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: engineType }),
      });

      if (!res.ok) {
        throw new Error("Failed to logout");
      }

      setLoggedOut(true);
      setTimeout(() => {
        setOpen(false);
        setLoggedOut(false);
        onLogout();
      }, 1000);
    } catch {
      // Keep dialog open on error
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-red-600 hover:text-red-700 hover:bg-red-500/10 dark:text-red-400 dark:hover:text-red-300"
      >
        {t("cli.auth.logout")}
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cli.auth.logout")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("cli.auth.logoutConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLogout}
              disabled={loading}
              variant="destructive"
            >
              {loading ? (
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="h-4 w-4 animate-spin"
                />
              ) : loggedOut ? (
                t("cli.auth.logoutSuccess")
              ) : (
                t("cli.auth.logout")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
