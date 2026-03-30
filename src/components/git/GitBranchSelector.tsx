"use client";

import { useState } from "react";
import { GitBranchPlus, Loader2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTranslation } from "@/hooks/useTranslation";
import type { GitBranches } from "@/types";

interface GitBranchSelectorProps {
  branches: GitBranches;
  pendingAction: string | null;
  onCheckout: (branch: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onDelete: (branch: string) => void;
}

export function GitBranchSelector({
  branches,
  pendingAction,
  onCheckout,
  onCreate,
  onDelete,
}: GitBranchSelectorProps) {
  const { t } = useTranslation();
  const [selectedBranch, setSelectedBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const activeBranch = branches.local.includes(selectedBranch)
    ? selectedBranch
    : branches.current || branches.local[0] || "";

  return (
    <Card className="gap-4">
      <CardHeader className="border-b">
        <CardTitle>{t("git.branchesTitle")}</CardTitle>
        <CardDescription>{t("git.branchesDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
          <Select value={activeBranch} onValueChange={setSelectedBranch} disabled={!branches.local.length || !!pendingAction}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("git.selectBranch")} />
            </SelectTrigger>
            <SelectContent>
              {branches.local.map((branch) => (
                <SelectItem key={branch} value={branch}>
                  {branch}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            onClick={() => onCheckout(activeBranch)}
            disabled={!activeBranch || activeBranch === branches.current || !!pendingAction}
          >
            {pendingAction === "checkout" ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("git.checkoutBranch")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onDelete(activeBranch)}
            disabled={!activeBranch || activeBranch === branches.current || !!pendingAction}
          >
            {pendingAction === "delete-branch" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            {t("git.deleteBranch")}
          </Button>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            value={newBranch}
            onChange={(event) => setNewBranch(event.target.value)}
            placeholder={t("git.newBranchPlaceholder")}
            disabled={!!pendingAction}
          />
          <Button
            type="button"
            onClick={() => {
              void (async () => {
                const created = await onCreate(newBranch);
                if (created) {
                  setNewBranch("");
                }
              })();
            }}
            disabled={!newBranch.trim() || !!pendingAction}
          >
            {pendingAction === "create-branch" ? <Loader2 className="size-4 animate-spin" /> : <GitBranchPlus className="size-4" />}
            {t("git.createAndCheckout")}
          </Button>
        </div>

        <div className="space-y-2">
          <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{t("git.remoteBranches")}</div>
          <div className="flex flex-wrap gap-2">
            {branches.remote.length ? (
              branches.remote.map((branch) => (
                <Badge key={branch} variant="outline">{branch}</Badge>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">{t("git.noRemoteBranches")}</span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
