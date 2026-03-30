import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseToml } from 'smol-toml';

export type GeminiCommandSource = 'global' | 'project';

export interface GeminiCommandMeta {
  description: string;
  prompt: string;
}

export interface GeminiCommandFile extends GeminiCommandMeta {
  name: string;
  content: string;
  source: GeminiCommandSource;
  filePath: string;
}

export interface GeminiCommandMatch {
  filePath: string;
  source: GeminiCommandSource;
}

export function getGeminiGlobalCommandsDir(): string {
  return path.join(os.homedir(), '.gemini', 'commands');
}

export function getGeminiProjectCommandsDir(cwd?: string): string {
  return path.join(cwd || process.cwd(), '.gemini', 'commands');
}

function getCommandSegments(name: string): string[] {
  return name.split(':').map((segment) => segment.trim()).filter(Boolean);
}

function getCommandName(prefix: string, baseName: string): string {
  return prefix ? `${prefix}:${baseName}` : baseName;
}

function deriveDescription(name: string, prompt: string): string {
  const firstPromptLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return firstPromptLine || `Command: /${name}`;
}

export function parseGeminiCommandContent(
  content: string,
  name: string,
): GeminiCommandMeta {
  try {
    const parsed = parseToml(content) as Record<string, unknown>;
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
    const description = typeof parsed.description === 'string'
      ? parsed.description
      : deriveDescription(name, prompt);

    return {
      description,
      prompt,
    };
  } catch {
    return {
      description: `Command: /${name}`,
      prompt: '',
    };
  }
}

export function scanGeminiCommands(
  dir: string,
  source: GeminiCommandSource,
  prefix = '',
): GeminiCommandFile[] {
  const commands: GeminiCommandFile[] = [];
  if (!fs.existsSync(dir)) return commands;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nextPrefix = getCommandName(prefix, entry.name);
        commands.push(...scanGeminiCommands(fullPath, source, nextPrefix));
        continue;
      }

      if (!entry.name.endsWith('.toml')) continue;

      const baseName = entry.name.replace(/\.toml$/i, '');
      const name = getCommandName(prefix, baseName);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const meta = parseGeminiCommandContent(content, name);

      commands.push({
        name,
        description: meta.description,
        prompt: meta.prompt,
        content,
        source,
        filePath: fullPath,
      });
    }
  } catch {
    // ignore read errors
  }

  return commands;
}

export function resolveGeminiCommandPath(dir: string, name: string): string {
  const segments = getCommandSegments(name);
  if (segments.length === 0) return '';

  const filename = `${segments.pop()}.toml`;
  return path.join(dir, ...segments, filename);
}

export function findGeminiCommandFile(name: string, cwd?: string): GeminiCommandMatch | null {
  const projectPath = resolveGeminiCommandPath(getGeminiProjectCommandsDir(cwd), name);
  if (projectPath && fs.existsSync(projectPath)) {
    return { filePath: projectPath, source: 'project' };
  }

  const globalPath = resolveGeminiCommandPath(getGeminiGlobalCommandsDir(), name);
  if (globalPath && fs.existsSync(globalPath)) {
    return { filePath: globalPath, source: 'global' };
  }

  return null;
}

export function buildGeminiCommandTemplate(name: string, prompt = ''): string {
  const description = `Command: /${name}`;
  const body = prompt.trim();

  return [
    `description = ${JSON.stringify(description)}`,
    'prompt = """',
    body,
    '"""',
    '',
  ].join('\n');
}

export function cleanupEmptyGeminiCommandDirs(filePath: string, cwd?: string): void {
  const projectRoot = getGeminiProjectCommandsDir(cwd);
  const globalRoot = getGeminiGlobalCommandsDir();
  const stopDir = filePath.startsWith(projectRoot) ? projectRoot : globalRoot;

  let currentDir = path.dirname(filePath);
  while (currentDir.startsWith(stopDir) && currentDir !== stopDir) {
    try {
      if (fs.readdirSync(currentDir).length > 0) break;
      fs.rmdirSync(currentDir);
      currentDir = path.dirname(currentDir);
    } catch {
      break;
    }
  }
}
