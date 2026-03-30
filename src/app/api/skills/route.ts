import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import {
  buildGeminiCommandTemplate,
  getGeminiGlobalCommandsDir,
  getGeminiProjectCommandsDir,
  parseGeminiCommandContent,
  resolveGeminiCommandPath,
  scanGeminiCommands,
} from "@/lib/gemini-commands";

export const dynamic = "force-dynamic";

interface SkillFile {
  name: string;
  description: string;
  content: string;
  prompt?: string;
  format?: "markdown" | "toml";
  source: "global" | "project" | "plugin" | "installed";
  installedSource?: "agents" | "claude";
  filePath: string;
}

type EngineType = "claude" | "codex" | "gemini";
type InstalledSource = "agents" | "claude";
type InstalledSkill = SkillFile & { installedSource: InstalledSource; contentHash: string };

function normalizeEngineType(value?: string | null): EngineType {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "codex") return "codex";
  if (normalized === "gemini") return "gemini";
  return "claude";
}

function getGlobalCommandsDir(): string {
  return path.join(os.homedir(), ".claude", "commands");
}

function getProjectCommandsDir(cwd?: string): string {
  return path.join(cwd || process.cwd(), ".claude", "commands");
}

function getProjectSkillsDir(cwd?: string): string {
  return path.join(cwd || process.cwd(), ".claude", "skills");
}

function getCodexGlobalSkillsDir(): string {
  return path.join(os.homedir(), ".codex", "skills");
}

function getCodexProjectSkillsDir(cwd?: string): string {
  return path.join(cwd || process.cwd(), ".codex", "skills");
}

function getPluginCommandsDirs(): string[] {
  const dirs: string[] = [];
  const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces");
  if (!fs.existsSync(marketplacesDir)) return dirs;

  try {
    // Scan marketplaces -> each marketplace -> plugins -> each plugin -> commands
    const marketplaces = fs.readdirSync(marketplacesDir);
    for (const marketplace of marketplaces) {
      const pluginsDir = path.join(marketplacesDir, marketplace, "plugins");
      if (!fs.existsSync(pluginsDir)) continue;
      const plugins = fs.readdirSync(pluginsDir);
      for (const plugin of plugins) {
        const commandsDir = path.join(pluginsDir, plugin, "commands");
        if (fs.existsSync(commandsDir)) {
          dirs.push(commandsDir);
        }
      }
    }
  } catch {
    // ignore
  }
  return dirs;
}

function getInstalledSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

function getClaudeSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

/**
 * Scan directory-based skills from {dir}/{name}/SKILL.md.
 */
function scanStructuredSkills(
  dir: string,
  source: "global" | "project" | "installed"
): SkillFile[] {
  const skills: SkillFile[] = [];
  if (!fs.existsSync(dir)) return skills;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, "utf-8");
      const meta = parseSkillFrontMatter(content);
      const name = meta.name || entry.name;
      const description = meta.description || `Skill: /${name}`;

      skills.push({
        name,
        description,
        content,
        source,
        filePath: skillMdPath,
      });
    }
  } catch {
    // ignore read errors
  }
  return skills;
}

function computeContentHash(content: string): string {
  return crypto.createHash("sha1").update(content, "utf8").digest("hex");
}

/**
 * Parse YAML front matter from SKILL.md content.
 * Extracts `name` and `description` fields from the --- delimited block.
 */
function parseSkillFrontMatter(content: string): { name?: string; description?: string } {
  // Extract front matter between --- delimiters
  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!fmMatch) return {};

  const frontMatter = fmMatch[1];
  const lines = frontMatter.split(/\r?\n/);
  const result: { name?: string; description?: string } = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match name: value
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) {
      result.name = nameMatch[1].trim();
      continue;
    }

    // Match description: | (multi-line YAML block scalar) — check FIRST
    if (/^description:\s*\|/.test(line)) {
      const descLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+/.test(lines[j])) {
          descLines.push(lines[j].trim());
        } else {
          break;
        }
      }
      if (descLines.length > 0) {
        result.description = descLines.filter(Boolean).join(" ");
      }
      continue;
    }

    // Match description: value (single-line)
    const descMatch = line.match(/^description:\s+(.+)/);
    if (descMatch) {
      result.description = descMatch[1].trim();
    }
  }
  return result;
}

/**
 * Scan a directory for installed skills.
 * Each skill is a subdirectory containing a SKILL.md with YAML front matter.
 * Used for both ~/.agents/skills/ and ~/.claude/skills/.
 */
function scanInstalledSkills(
  dir: string,
  installedSource: InstalledSource
): InstalledSkill[] {
  const skills: InstalledSkill[] = [];
  if (!fs.existsSync(dir)) return skills;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, "utf-8");
      const meta = parseSkillFrontMatter(content);
      const name = meta.name || entry.name;
      const description = meta.description || `Installed skill: /${name}`;
      const contentHash = computeContentHash(content);

      skills.push({
        name,
        description,
        content,
        source: "installed",
        installedSource,
        contentHash,
        filePath: skillMdPath,
      });
    }
  } catch {
    // ignore read errors
  }
  return skills;
}

function resolveInstalledSkills(
  agentsSkills: InstalledSkill[],
  claudeSkills: InstalledSkill[],
  preferredSource: InstalledSource
): SkillFile[] {
  const all = [...agentsSkills, ...claudeSkills];
  const byName = new Map<string, InstalledSkill[]>();
  for (const skill of all) {
    const existing = byName.get(skill.name);
    if (existing) {
      existing.push(skill);
    } else {
      byName.set(skill.name, [skill]);
    }
  }

  const resolved: InstalledSkill[] = [];
  for (const group of byName.values()) {
    if (group.length === 1) {
      resolved.push(group[0]);
      continue;
    }

    const uniqueHashes = new Set(group.map((s) => s.contentHash));
    if (uniqueHashes.size === 1) {
      const preferred =
        group.find((s) => s.installedSource === preferredSource) || group[0];
      resolved.push(preferred);
      continue;
    }

    resolved.push(...group);
  }

  return resolved.map(({ contentHash, ...rest }) => {
    void contentHash;
    return rest;
  });
}

function scanDirectory(
  dir: string,
  source: "global" | "project" | "plugin",
  prefix = ""
): SkillFile[] {
  const skills: SkillFile[] = [];
  if (!fs.existsSync(dir)) return skills;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectories (e.g. ~/.claude/commands/review/pr.md)
        const subPrefix = prefix ? `${prefix}:${entry.name}` : entry.name;
        skills.push(...scanDirectory(fullPath, source, subPrefix));
        continue;
      }

      if (!entry.name.endsWith(".md")) continue;
      const baseName = entry.name.replace(/\.md$/, "");
      const name = prefix ? `${prefix}:${baseName}` : baseName;
      const filePath = fullPath;
      const content = fs.readFileSync(filePath, "utf-8");
      const firstLine = content.split("\n")[0]?.trim() || "";
      const description = firstLine.startsWith("#")
        ? firstLine.replace(/^#+\s*/, "")
        : firstLine || `Skill: /${name}`;
      skills.push({ name, description, content, source, filePath });
    }
  } catch {
    // ignore read errors
  }
  return skills;
}

export async function GET(request: NextRequest) {
  try {
    // Accept optional cwd query param for project-level skills
    const cwd = request.nextUrl.searchParams.get("cwd") || undefined;
    const engineType = normalizeEngineType(request.nextUrl.searchParams.get("engine_type"));

    if (engineType === "codex") {
      const globalSkillsDir = getCodexGlobalSkillsDir();
      const projectSkillsDir = getCodexProjectSkillsDir(cwd);

      const globalSkills = scanStructuredSkills(globalSkillsDir, "global");
      const projectSkills = scanStructuredSkills(projectSkillsDir, "project");

      // Project skills override global skills with the same name
      const projectNames = new Set(projectSkills.map((skill) => skill.name));
      const dedupedGlobalSkills = globalSkills.filter((skill) => !projectNames.has(skill.name));
      const all = [...projectSkills, ...dedupedGlobalSkills];

      return NextResponse.json({ skills: all });
    }

    if (engineType === "gemini") {
      const globalCommands = scanGeminiCommands(getGeminiGlobalCommandsDir(), "global");
      const projectCommands = scanGeminiCommands(getGeminiProjectCommandsDir(cwd), "project");
      const projectNames = new Set(projectCommands.map((command) => command.name));
      const dedupedGlobalCommands = globalCommands.filter(
        (command) => !projectNames.has(command.name)
      );

      return NextResponse.json({
        skills: [...projectCommands, ...dedupedGlobalCommands].map((command) => ({
          ...command,
          format: "toml" as const,
        })),
      });
    }

    const globalDir = getGlobalCommandsDir();
    const projectDir = getProjectCommandsDir(cwd);

    console.log(`[skills] Scanning global: ${globalDir} (exists: ${fs.existsSync(globalDir)})`);
    console.log(`[skills] Scanning project: ${projectDir} (exists: ${fs.existsSync(projectDir)})`);
    console.log(`[skills] HOME=${process.env.HOME}, homedir=${os.homedir()}`);

    const globalSkills = scanDirectory(globalDir, "global");
    const projectSkills = scanDirectory(projectDir, "project");

    // Scan project-level skills (.claude/skills/*/SKILL.md)
    const projectSkillsDir = getProjectSkillsDir(cwd);
    console.log(`[skills] Scanning project skills: ${projectSkillsDir} (exists: ${fs.existsSync(projectSkillsDir)})`);
    const projectLevelSkills = scanStructuredSkills(projectSkillsDir, "project");
    console.log(`[skills] Found ${projectLevelSkills.length} project-level skills`);

    // Deduplicate: project commands take priority over project skills with the same name
    const projectCommandNames = new Set(projectSkills.map((s) => s.name));
    const dedupedProjectSkills = projectLevelSkills.filter(
      (s) => !projectCommandNames.has(s.name)
    );

    const agentsSkillsDir = getInstalledSkillsDir();
    const claudeSkillsDir = getClaudeSkillsDir();
    console.log(`[skills] Scanning installed: ${agentsSkillsDir} (exists: ${fs.existsSync(agentsSkillsDir)})`);
    console.log(`[skills] Scanning installed: ${claudeSkillsDir} (exists: ${fs.existsSync(claudeSkillsDir)})`);
    const agentsSkills = scanInstalledSkills(agentsSkillsDir, "agents");
    const claudeSkills = scanInstalledSkills(claudeSkillsDir, "claude");
    const preferredInstalledSource: InstalledSource =
      agentsSkills.length === claudeSkills.length
        ? "claude"
        : agentsSkills.length > claudeSkills.length
          ? "agents"
          : "claude";
    console.log(
      `[skills] Installed counts: agents=${agentsSkills.length}, claude=${claudeSkills.length}, preferred=${preferredInstalledSource}`
    );
    const installedSkills = resolveInstalledSkills(
      agentsSkills,
      claudeSkills,
      preferredInstalledSource
    );

    // Scan installed plugin skills
    const pluginSkills: SkillFile[] = [];
    for (const dir of getPluginCommandsDirs()) {
      pluginSkills.push(...scanDirectory(dir, "plugin"));
    }

    const all = [...globalSkills, ...projectSkills, ...dedupedProjectSkills, ...installedSkills, ...pluginSkills];
    console.log(`[skills] Found: global=${globalSkills.length}, project=${projectSkills.length}, projectSkills=${dedupedProjectSkills.length}, installed=${installedSkills.length}, plugin=${pluginSkills.length}`);

    return NextResponse.json({ skills: all });
  } catch (error) {
    console.error('[skills] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load skills" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, content, scope, cwd, engine_type } = body as {
      name: string;
      content: string;
      scope: "global" | "project";
      cwd?: string;
      engine_type?: string;
    };
    const engineType = normalizeEngineType(engine_type);

    if (!name || typeof name !== "string") {
      return NextResponse.json(
        { error: "Skill name is required" },
        { status: 400 }
      );
    }

    // Sanitize name: Gemini also supports grouped command names via ":".
    const safeName = engineType === "gemini"
      ? name
          .replace(/[^a-zA-Z0-9_:-]/g, "-")
          .replace(/:+/g, ":")
          .replace(/^:+|:+$/g, "")
      : name.replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!safeName) {
      return NextResponse.json(
        { error: "Invalid skill name" },
        { status: 400 }
      );
    }

    if (engineType === "codex") {
      const dir =
        scope === "project" ? getCodexProjectSkillsDir(cwd) : getCodexGlobalSkillsDir();
      const skillDir = path.join(dir, safeName);
      const filePath = path.join(skillDir, "SKILL.md");

      if (fs.existsSync(filePath)) {
        return NextResponse.json(
          { error: "A skill with this name already exists" },
          { status: 409 }
        );
      }

      if (!fs.existsSync(skillDir)) {
        fs.mkdirSync(skillDir, { recursive: true });
      }

      const finalContent = content && content.trim()
        ? content
        : `---\nname: ${safeName}\ndescription: Skill: /${safeName}\n---\n\n`;
      fs.writeFileSync(filePath, finalContent, "utf-8");

      const meta = parseSkillFrontMatter(finalContent);
      const firstLine = finalContent.split("\n")[0]?.trim() || "";
      const description = meta.description
        || (firstLine.startsWith("#")
          ? firstLine.replace(/^#+\s*/, "")
          : firstLine || `Skill: /${safeName}`);

      return NextResponse.json(
        {
          skill: {
            name: safeName,
            description,
            content: finalContent,
            source: scope || "global",
            filePath,
          },
        },
        { status: 201 }
      );
    }

    if (engineType === "gemini") {
      const dir =
        scope === "project" ? getGeminiProjectCommandsDir(cwd) : getGeminiGlobalCommandsDir();
      const filePath = resolveGeminiCommandPath(dir, safeName);
      if (!filePath) {
        return NextResponse.json(
          { error: "Invalid command name" },
          { status: 400 }
        );
      }

      if (fs.existsSync(filePath)) {
        return NextResponse.json(
          { error: "A command with this name already exists" },
          { status: 409 }
        );
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      const finalContent = content && content.trim()
        ? content
        : buildGeminiCommandTemplate(safeName);
      fs.writeFileSync(filePath, finalContent, "utf-8");

      const meta = parseGeminiCommandContent(finalContent, safeName);

      return NextResponse.json(
        {
          skill: {
            name: safeName,
            description: meta.description,
            prompt: meta.prompt,
            content: finalContent,
            format: "toml" as const,
            source: scope || "global",
            filePath,
          },
        },
        { status: 201 }
      );
    }

    const dir =
      scope === "project" ? getProjectCommandsDir(cwd) : getGlobalCommandsDir();

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const filePath = path.join(dir, `${safeName}.md`);
    if (fs.existsSync(filePath)) {
      return NextResponse.json(
        { error: "A skill with this name already exists" },
        { status: 409 }
      );
    }

    fs.writeFileSync(filePath, content || "", "utf-8");

    const firstLine = (content || "").split("\n")[0]?.trim() || "";
    const description = firstLine.startsWith("#")
      ? firstLine.replace(/^#+\s*/, "")
      : firstLine || `Skill: /${safeName}`;

    return NextResponse.json(
      {
        skill: {
          name: safeName,
          description,
          content: content || "",
          source: scope || "global",
          filePath,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create skill" },
      { status: 500 }
    );
  }
}
