"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, GlobeIcon, FolderOpenIcon } from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";

interface CreateSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultEngineType: "claude" | "codex" | "gemini";
  onCreate: (
    name: string,
    scope: "global" | "project",
    engineType: "claude" | "codex" | "gemini",
    content: string
  ) => Promise<void>;
}

const SKILL_TEMPLATES: { label: string; content: string }[] = [
  { label: "Blank", content: "" },
  {
    label: "Commit Helper",
    content: `# Commit Helper

Review the staged changes and generate a concise, descriptive commit message following conventional commit format.

Rules:
- Use conventional commit prefixes: feat, fix, refactor, docs, test, chore
- Keep the first line under 72 characters
- Add a blank line and detailed description if needed
- Reference relevant issue numbers if applicable
`,
  },
  {
    label: "Code Reviewer",
    content: `# Code Reviewer

Review the provided code and give feedback on:

1. **Correctness** - Logic errors, edge cases, potential bugs
2. **Performance** - Inefficiencies, unnecessary allocations
3. **Readability** - Naming, structure, comments where needed
4. **Security** - Input validation, injection risks, data exposure

Be specific with line references. Suggest concrete improvements, not just problems.
`,
  },
];

const GEMINI_COMMAND_TEMPLATES: { label: string; content: string }[] = [
  {
    label: "Blank",
    content: `description = "Command: /my-command"
prompt = """

"""`,
  },
  {
    label: "Code Review",
    content: `description = "Review the relevant code changes"
prompt = """
Review the relevant code changes and identify correctness, regression, performance, and security issues.

Rules:
- Prioritize concrete bugs and behavioral regressions
- Include file references when possible
- Be concise and actionable
"""`,
  },
  {
    label: "Commit Helper",
    content: `description = "Generate a conventional commit message"
prompt = """
Review the staged changes and draft a concise conventional commit message.

Rules:
- Use feat, fix, refactor, docs, test, or chore
- Keep the subject under 72 characters
- Add a body only if it materially improves clarity
"""`,
  },
];

export function CreateSkillDialog({
  open,
  onOpenChange,
  defaultEngineType,
  onCreate,
}: CreateSkillDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "project">("project");
  const [engineType, setEngineType] = useState<"claude" | "codex" | "gemini">(defaultEngineType);
  const [templateIdx, setTemplateIdx] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const templates = engineType === "gemini" ? GEMINI_COMMAND_TEMPLATES : SKILL_TEMPLATES;
  const titleText = engineType === "gemini" ? t('skills.createCommand') : t('skills.createSkill');
  const nameLabel = engineType === "gemini" ? t('skills.commandName') : t('skills.skillName');
  const createButtonLabel = engineType === "gemini" ? t('skills.createCommand') : t('skills.createSkill');

  useEffect(() => {
    if (open) {
      setEngineType(defaultEngineType);
      setTemplateIdx(0);
    }
  }, [defaultEngineType, open]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('skills.nameRequired'));
      return;
    }
    const namePattern = engineType === "gemini" ? /^[a-zA-Z0-9_:-]+$/ : /^[a-zA-Z0-9_-]+$/;
    if (!namePattern.test(trimmed)) {
      setError(engineType === "gemini" ? t('skills.nameInvalidGemini') : t('skills.nameInvalid'));
      return;
    }

    setCreating(true);
    setError("");
    try {
      await onCreate(trimmed, scope, engineType, templates[templateIdx].content);
      // Reset on success
      setName("");
      setScope("project");
      setEngineType(defaultEngineType);
      setTemplateIdx(0);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{titleText}</DialogTitle>
          <DialogDescription>
            {engineType === "gemini"
              ? "Create a new Gemini command file for the selected runtime scope."
              : "Create a new skill file for the selected runtime."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Name input */}
          <div className="space-y-2">
            <Label htmlFor="skill-name">{nameLabel}</Label>
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground">/</span>
              <Input
                id="skill-name"
                placeholder="my-skill"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
              />
            </div>
          </div>

          {/* Runtime selection */}
          <div className="space-y-2">
            <Label>Runtime</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setEngineType("claude")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  engineType === "claude"
                    ? "border-blue-500/50 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    : "border-border hover:bg-accent"
                )}
              >
                Claude
              </button>
              <button
                type="button"
                onClick={() => setEngineType("codex")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  engineType === "codex"
                    ? "border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400"
                    : "border-border hover:bg-accent"
                )}
              >
                Codex
              </button>
              <button
                type="button"
                onClick={() => setEngineType("gemini")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  engineType === "gemini"
                    ? "border-orange-500/50 bg-orange-500/10 text-orange-600 dark:text-orange-400"
                    : "border-border hover:bg-accent"
                )}
              >
                Gemini
              </button>
            </div>
          </div>

          {/* Scope selection */}
          <div className="space-y-2">
            <Label>{t('skills.scope')}</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setScope("project")}
                className={cn(
                  "flex-1 flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  scope === "project"
                    ? "border-blue-500/50 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    : "border-border hover:bg-accent"
                )}
              >
                <HugeiconsIcon icon={FolderOpenIcon} className="h-4 w-4" />
                {t('skills.project')}
              </button>
              <button
                type="button"
                onClick={() => setScope("global")}
                className={cn(
                  "flex-1 flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  scope === "global"
                    ? "border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400"
                    : "border-border hover:bg-accent"
                )}
              >
                <HugeiconsIcon icon={GlobeIcon} className="h-4 w-4" />
                {t('skills.global')}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {engineType === "codex"
                ? (
                  scope === "project"
                    ? "Saved in .codex/skills/<name>/SKILL.md (this project only)"
                    : "Saved in ~/.codex/skills/<name>/SKILL.md (available everywhere)"
                )
                : engineType === "gemini"
                  ? (
                    scope === "project"
                      ? "Saved in .gemini/commands/<name>.toml (this project only)"
                      : "Saved in ~/.gemini/commands/<name>.toml (available everywhere)"
                  )
                : (
                  scope === "project"
                    ? "Saved in .claude/commands/ (this project only)"
                    : "Saved in ~/.claude/commands/ (available everywhere)"
                )}
            </p>
          </div>

          {/* Template selection */}
          <div className="space-y-2">
            <Label>{t('skills.template')}</Label>
            <div className="flex gap-2 flex-wrap">
              {templates.map((tpl, i) => (
                <button
                  key={tpl.label}
                  type="button"
                  onClick={() => setTemplateIdx(i)}
                  className={cn(
                    "rounded-md border px-3 py-1 text-xs transition-colors",
                    templateIdx === i
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-accent"
                  )}
                >
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={creating} className="gap-2">
            {creating && <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />}
            {createButtonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
