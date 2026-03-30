import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readRuntimeSettings, readRuntimeMcpServers } from '@/lib/runtime-config';
import { resolveGeminiCliPath } from '@/lib/gemini-cli';
import { DEFAULT_GEMINI_MODEL_OPTIONS } from '@/lib/gemini-model-options';
import type { NativeCommandControllerRequest, NativeCommandControllerResponse } from '@/types';

const execFileAsync = promisify(execFile);

const NATIVE_COMMAND_NAMES = new Set([
  'about', 'mcp', 'permissions', 'settings', 'auth',
  'memory', 'agents', 'extensions', 'hooks', 'skills', 'tools',
  'doctor', 'diff', 'model', 'init',
  'profile', 'policies', 'rewind',
]);

function toMarkdownCode(value: string): string {
  return `\`${value}\``;
}

function readGeminiMemoryFiles(workingDirectory?: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const globalPath = path.join(os.homedir(), '.gemini', 'GEMINI.md');
  if (fs.existsSync(globalPath)) {
    try { files.push({ path: globalPath, content: fs.readFileSync(globalPath, 'utf-8') }); } catch { /* skip */ }
  }
  if (workingDirectory) {
    const projectPath = path.join(workingDirectory, 'GEMINI.md');
    if (fs.existsSync(projectPath)) {
      try { files.push({ path: projectPath, content: fs.readFileSync(projectPath, 'utf-8') }); } catch { /* skip */ }
    }
  }
  return files;
}

function formatGeminiMcpStatus(mcpServers: Record<string, unknown>): string {
  const entries = Object.entries(mcpServers);
  if (entries.length === 0) {
    return '## Gemini MCP Servers\n\nNo MCP servers configured in `~/.gemini/settings.json`.';
  }
  const lines = entries.map(([name]) => `- ${toMarkdownCode(name)}`);
  return ['## Gemini MCP Servers', '', `${entries.length} server(s) configured:`, '', ...lines].join('\n');
}

function formatGeminiSettings(settings: Record<string, unknown>): string {
  if (Object.keys(settings).length === 0) {
    return '## Gemini Settings\n\nNo settings found in `~/.gemini/settings.json`.';
  }
  return ['## Gemini Settings', '', '```json', JSON.stringify(settings, null, 2), '```'].join('\n');
}

function formatGeminiAuth(settings: Record<string, unknown>): string {
  const security = settings.security as Record<string, unknown> | undefined;
  const auth = (security?.auth || settings.auth) as Record<string, unknown> | undefined;
  const selectedType = auth?.selectedType || auth?.type;
  const lines = ['## Gemini Authentication'];
  lines.push('');
  if (selectedType) {
    lines.push(`- Auth type: ${toMarkdownCode(String(selectedType))}`);
  }
  // Check env vars
  const envKeys = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'];
  for (const key of envKeys) {
    if (process.env[key]) {
      lines.push(`- ${toMarkdownCode(key)}: set`);
    }
  }
  if (lines.length === 2) {
    lines.push('No authentication configured. Set `GEMINI_API_KEY` or run `gemini auth login`.');
  }
  return lines.join('\n');
}

function formatGeminiPermissions(settings: Record<string, unknown>): string {
  const trust = settings.trust || settings.permissions;
  const lines = ['## Gemini Permissions'];
  lines.push('');
  if (trust && typeof trust === 'object') {
    lines.push('```json', JSON.stringify(trust, null, 2), '```');
  } else {
    lines.push('No folder trust settings configured.');
  }
  return lines.join('\n');
}

function readGeminiSubdir(settingsDir: string, subdir: string): string[] {
  const dir = path.join(settingsDir, subdir);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  } catch { return []; }
}

async function getGeminiVersion(): Promise<string> {
  const cliPath = resolveGeminiCliPath();
  if (!cliPath) return '(not found)';
  try {
    const { stdout } = await execFileAsync(cliPath, ['--version'], { timeout: 5000 });
    return stdout.trim() || '(unknown)';
  } catch {
    return '(error)';
  }
}

export async function runGeminiNativeCommand(
  request: NativeCommandControllerRequest,
): Promise<NativeCommandControllerResponse> {
  const commandName = request.command_name.trim().toLowerCase();
  if (!NATIVE_COMMAND_NAMES.has(commandName)) {
    return { handled: false, message: `Unsupported native command: /${commandName}`, error: 'UNSUPPORTED_NATIVE_COMMAND' };
  }
  if (request.engine_type !== 'gemini') {
    return { handled: false, message: `Gemini controller unavailable for engine "${request.engine_type}".`, error: 'UNSUPPORTED_ENGINE' };
  }

  const workingDirectory = request.context?.working_directory || undefined;
  const settingsDir = path.join(os.homedir(), '.gemini');

  try {
    switch (commandName) {
      case 'about': {
        const version = await getGeminiVersion();
        return {
          handled: true,
          message: `## Gemini CLI\n\nVersion: ${toMarkdownCode(version)}`,
          data: { version },
        };
      }

      case 'mcp': {
        const { mcpServers } = readRuntimeMcpServers('gemini');
        return {
          handled: true,
          message: formatGeminiMcpStatus(mcpServers),
          data: { mcp_servers: mcpServers },
        };
      }

      case 'settings': {
        const settings = readRuntimeSettings('gemini');
        return {
          handled: true,
          message: formatGeminiSettings(settings),
          data: { settings },
        };
      }

      case 'auth': {
        const settings = readRuntimeSettings('gemini');
        return {
          handled: true,
          message: formatGeminiAuth(settings),
          data: { settings },
        };
      }

      case 'permissions': {
        const settings = readRuntimeSettings('gemini');
        const permArg = request.args?.trim();
        if (permArg) {
          if (!settings.permissions || typeof settings.permissions !== 'object') {
            settings.permissions = {};
          }
          (settings.permissions as Record<string, unknown>).defaultMode = permArg;
          const { syncConfigToFile: syncGemPerm } = await import('@/lib/config-sync');
          syncGemPerm('gemini', { mode: permArg });
          return {
            handled: true,
            message: `Gemini permissions mode set to ${permArg}.`,
            state_patch: { mode: permArg },
            data: { permissions_mode: permArg },
          };
        }
        return {
          handled: true,
          message: formatGeminiPermissions(settings),
          data: { settings },
        };
      }

      case 'memory': {
        const files = readGeminiMemoryFiles(workingDirectory);
        if (files.length === 0) {
          return {
            handled: true,
            message: '## Gemini Memory\n\nNo GEMINI.md files found. Use `/init` to create one.',
          };
        }
        const sections = files.map(f => `### ${toMarkdownCode(f.path)}\n\n${f.content}`);
        return {
          handled: true,
          message: ['## Gemini Memory', '', ...sections].join('\n'),
          data: { files: files.map(f => f.path) },
        };
      }

      case 'agents': {
        const items = readGeminiSubdir(settingsDir, 'agents');
        const projectItems = workingDirectory ? readGeminiSubdir(path.join(workingDirectory, '.gemini'), 'agents') : [];
        const all = [...new Set([...items, ...projectItems])];
        return {
          handled: true,
          message: all.length > 0
            ? ['## Gemini Agents', '', ...all.map(a => `- ${toMarkdownCode(a)}`)].join('\n')
            : '## Gemini Agents\n\nNo agents configured.',
        };
      }

      case 'extensions': {
        const settings = readRuntimeSettings('gemini');
        const extensions = settings.extensions;
        return {
          handled: true,
          message: extensions && typeof extensions === 'object'
            ? ['## Gemini Extensions', '', '```json', JSON.stringify(extensions, null, 2), '```'].join('\n')
            : '## Gemini Extensions\n\nNo extensions configured.',
        };
      }

      case 'hooks': {
        const items = workingDirectory ? readGeminiSubdir(path.join(workingDirectory, '.gemini'), 'hooks') : [];
        const globalItems = readGeminiSubdir(settingsDir, 'hooks');
        const all = [...new Set([...items, ...globalItems])];
        return {
          handled: true,
          message: all.length > 0
            ? ['## Gemini Hooks', '', ...all.map(h => `- ${toMarkdownCode(h)}`)].join('\n')
            : '## Gemini Hooks\n\nNo hooks configured.',
        };
      }

      case 'skills': {
        const items = readGeminiSubdir(settingsDir, 'skills');
        return {
          handled: true,
          message: items.length > 0
            ? ['## Gemini Skills', '', ...items.map(s => `- ${toMarkdownCode(s)}`)].join('\n')
            : '## Gemini Skills\n\nNo skills configured.',
        };
      }

      case 'tools': {
        const { mcpServers } = readRuntimeMcpServers('gemini');
        const serverNames = Object.keys(mcpServers);
        return {
          handled: true,
          message: serverNames.length > 0
            ? ['## Gemini Tools', '', `${serverNames.length} MCP server(s) configured, providing tools:`, '', ...serverNames.map(n => `- ${toMarkdownCode(n)}`)].join('\n')
            : '## Gemini Tools\n\nNo MCP servers configured. Tools are loaded from MCP servers.',
        };
      }

      case 'doctor': {
        const version = await getGeminiVersion();
        const settings = readRuntimeSettings('gemini');
        const { mcpServers } = readRuntimeMcpServers('gemini');
        const security = settings.security as Record<string, unknown> | undefined;
        const auth = (security?.auth || settings.auth) as Record<string, unknown> | undefined;
        const hasAuth = Boolean(auth?.selectedType || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
        return {
          handled: true,
          message: [
            '## Gemini Health Check',
            '',
            `- CLI version: ${toMarkdownCode(version)}`,
            `- Authentication: ${hasAuth ? '✓ configured' : '✗ not configured'}`,
            `- MCP servers: ${Object.keys(mcpServers).length}`,
            `- Settings file: ${toMarkdownCode(path.join(settingsDir, 'settings.json'))}`,
          ].join('\n'),
        };
      }

      case 'diff': {
        try {
          const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD'], {
            cwd: workingDirectory || process.cwd(),
            timeout: 10000,
          });
          const diffOutput = stdout.trim();
          return {
            handled: true,
            message: diffOutput
              ? ['## Git Diff', '', '```', diffOutput, '```'].join('\n')
              : '## Git Diff\n\nNo changes detected.',
          };
        } catch {
          return { handled: true, message: '## Git Diff\n\nFailed to run `git diff`. Is this a git repository?' };
        }
      }

      case 'model': {
        const args = request.args?.trim();

        // /model <name> → switch model and persist to ~/.gemini/settings.json
        if (args) {
          const { syncConfigToFile: syncGem } = await import('@/lib/config-sync');
          syncGem('gemini', { model: args });
          return {
            handled: true,
            message: `Model switched to ${toMarkdownCode(args)}.`,
            state_patch: { model: args },
            data: { model: args },
          };
        }

        // /model (no args) → list available models
        const settings = readRuntimeSettings('gemini');
        const configuredModel = (settings.model as string) || process.env.GEMINI_MODEL || '';
        const currentModel = request.context?.model || configuredModel || '(default)';

        const modelLines = DEFAULT_GEMINI_MODEL_OPTIONS.map(
          (m) => `- ${toMarkdownCode(m.value)}${m.value === currentModel ? ' ← current' : ''}`
        );

        return {
          handled: true,
          message: [
            '## Gemini Models',
            '',
            `Current model: ${toMarkdownCode(currentModel)}`,
            '',
            'Available models:',
            '',
            ...modelLines,
            '',
            'Use `/model <name>` to switch.',
          ].join('\n'),
          data: { current_model: currentModel, models: DEFAULT_GEMINI_MODEL_OPTIONS },
        };
      }

      case 'init': {
        const targetDir = workingDirectory || process.cwd();
        const geminiMdPath = path.join(targetDir, 'GEMINI.md');

        if (fs.existsSync(geminiMdPath)) {
          const content = fs.readFileSync(geminiMdPath, 'utf-8');
          return {
            handled: true,
            message: [
              '## GEMINI.md already exists',
              '',
              `Location: ${toMarkdownCode(geminiMdPath)}`,
              '',
              '```markdown',
              content.length > 500 ? content.slice(0, 500) + '\n...(truncated)' : content,
              '```',
            ].join('\n'),
            data: { path: geminiMdPath, exists: true },
          };
        }

        const template = [
          '# Project Context',
          '',
          '<!-- Gemini will read this file for project-specific instructions. -->',
          '',
          '## Overview',
          '',
          'Describe your project here.',
          '',
          '## Conventions',
          '',
          '- Language: ',
          '- Framework: ',
          '- Style guide: ',
          '',
        ].join('\n');

        try {
          const geminiDir = path.join(targetDir, '.gemini');
          if (!fs.existsSync(geminiDir)) {
            fs.mkdirSync(geminiDir, { recursive: true });
          }
          fs.writeFileSync(geminiMdPath, template, 'utf-8');
          return {
            handled: true,
            message: `Created ${toMarkdownCode(geminiMdPath)}. Edit it to provide project context to Gemini.`,
            data: { path: geminiMdPath, created: true },
          };
        } catch (err) {
          return {
            handled: true,
            message: `Failed to create GEMINI.md: ${err instanceof Error ? err.message : String(err)}`,
            error: 'INIT_FAILED',
          };
        }
      }

      case 'profile': {
        const settings = readRuntimeSettings('gemini');
        const profile = settings.profile as Record<string, unknown> | undefined;
        if (profile && typeof profile === 'object' && Object.keys(profile).length > 0) {
          return {
            handled: true,
            message: ['## Gemini Profile', '', '```json', JSON.stringify(profile, null, 2), '```'].join('\n'),
            data: { profile },
          };
        }
        return {
          handled: true,
          message: '## Gemini Profile\n\nNo profile configured in `~/.gemini/settings.json`.',
        };
      }

      case 'policies': {
        // /policies is an alias for /permissions — delegate
        const settings = readRuntimeSettings('gemini');
        return {
          handled: true,
          message: formatGeminiPermissions(settings),
          data: { settings },
        };
      }

      case 'rewind': {
        const cwd = workingDirectory || process.cwd();
        try {
          const { stdout } = await execFileAsync('git', ['log', '--oneline', '-5'], {
            cwd,
            timeout: 10000,
          });
          const logOutput = stdout.trim();
          if (!logOutput) {
            return {
              handled: true,
              message: '## Rewind\n\nNo git history found in this directory.',
            };
          }
          return {
            handled: true,
            message: ['## Rewind — Recent Commits', '', '```', logOutput, '```', '', 'Use `git revert <commit>` to undo specific changes.'].join('\n'),
          };
        } catch {
          return {
            handled: true,
            message: '## Rewind\n\nFailed to read git history. Is this a git repository?',
          };
        }
      }

      default:
        return { handled: false, message: `Unsupported native command: /${commandName}`, error: 'UNSUPPORTED_NATIVE_COMMAND' };
    }
  } catch (error) {
    return {
      handled: false,
      message: error instanceof Error ? error.message : String(error),
      error: 'NATIVE_COMMAND_FAILED',
    };
  }
}
