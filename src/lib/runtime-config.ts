import fs from "fs";
import os from "os";
import path from "path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { normalizeEngineType, type EngineType } from "@/lib/engine-defaults";
import type { MCPServerConfig } from "@/types";

export type RuntimeSettingsFormat = "json" | "toml";

interface RuntimeConfigTarget {
  engine: EngineType;
  format: RuntimeSettingsFormat;
  path: string;
  mcpKey: "mcpServers" | "mcp_servers";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStructuredFile(
  filePath: string,
  format: RuntimeSettingsFormat
): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.trim()) {
      return {};
    }
    const parsed = format === "toml" ? parseToml(content) : JSON.parse(content);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStructuredFile(
  filePath: string,
  format: RuntimeSettingsFormat,
  data: Record<string, unknown>
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const serialized = format === "toml"
    ? stringifyToml(data)
    : `${JSON.stringify(data, null, 2)}\n`;

  fs.writeFileSync(filePath, serialized, "utf-8");
}

function getClaudeLegacyConfigPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

function normalizeMcpServers(value: unknown): Record<string, MCPServerConfig> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, MCPServerConfig> = {};
  for (const [name, server] of Object.entries(value)) {
    if (!isRecord(server)) continue;

    result[name] = {
      command: typeof server.command === "string" ? server.command : "",
      ...(Array.isArray(server.args)
        ? { args: server.args.filter((arg): arg is string => typeof arg === "string") }
        : {}),
      ...(isRecord(server.env)
        ? {
            env: Object.fromEntries(
              Object.entries(server.env)
                .filter(([, envValue]) => typeof envValue === "string")
                .map(([key, envValue]) => [key, envValue as string])
            ),
          }
        : {}),
      ...(typeof server.type === "string" ? { type: server.type as MCPServerConfig["type"] } : {}),
      ...(typeof server.url === "string" ? { url: server.url } : {}),
      ...(isRecord(server.headers)
        ? {
            headers: Object.fromEntries(
              Object.entries(server.headers)
                .filter(([, headerValue]) => typeof headerValue === "string")
                .map(([key, headerValue]) => [key, headerValue as string])
            ),
          }
        : {}),
    };
  }

  return result;
}

function clearClaudeLegacyMcpServers(): void {
  const legacyPath = getClaudeLegacyConfigPath();
  const legacy = readStructuredFile(legacyPath, "json");
  if (!("mcpServers" in legacy)) {
    return;
  }
  delete legacy.mcpServers;
  writeStructuredFile(legacyPath, "json", legacy);
}

export function getRuntimeConfigTarget(engine?: string | null): RuntimeConfigTarget {
  const resolvedEngine = normalizeEngineType(engine);

  if (resolvedEngine === "codex") {
    return {
      engine: resolvedEngine,
      format: "toml",
      path: path.join(os.homedir(), ".codex", "config.toml"),
      mcpKey: "mcp_servers",
    };
  }

  if (resolvedEngine === "gemini") {
    return {
      engine: resolvedEngine,
      format: "json",
      path: path.join(os.homedir(), ".gemini", "settings.json"),
      mcpKey: "mcpServers",
    };
  }

  return {
    engine: "claude",
    format: "json",
    path: path.join(os.homedir(), ".claude", "settings.json"),
    mcpKey: "mcpServers",
  };
}

export function readRuntimeSettings(engine?: string | null): Record<string, unknown> {
  const target = getRuntimeConfigTarget(engine);
  return readStructuredFile(target.path, target.format);
}

export function writeRuntimeSettings(
  engine: string | null | undefined,
  data: Record<string, unknown>
): RuntimeConfigTarget {
  const target = getRuntimeConfigTarget(engine);
  writeStructuredFile(target.path, target.format, data);
  return target;
}

export function readRuntimeMcpServers(engine?: string | null): {
  engine: EngineType;
  format: RuntimeSettingsFormat;
  path: string;
  mcpServers: Record<string, MCPServerConfig>;
} {
  const target = getRuntimeConfigTarget(engine);
  const settings = readRuntimeSettings(target.engine);
  const settingsMcpServers = normalizeMcpServers(settings[target.mcpKey]);

  if (target.engine !== "claude") {
    return {
      engine: target.engine,
      format: target.format,
      path: target.path,
      mcpServers: settingsMcpServers,
    };
  }

  const legacy = readStructuredFile(getClaudeLegacyConfigPath(), "json");
  const legacyMcpServers = normalizeMcpServers(legacy.mcpServers);

  return {
    engine: target.engine,
    format: target.format,
    path: target.path,
    mcpServers: {
      ...legacyMcpServers,
      ...settingsMcpServers,
    },
  };
}

export function writeRuntimeMcpServers(
  engine: string | null | undefined,
  mcpServers: Record<string, MCPServerConfig>
): RuntimeConfigTarget {
  const target = getRuntimeConfigTarget(engine);
  const settings = readRuntimeSettings(target.engine);
  settings[target.mcpKey] = mcpServers;
  writeRuntimeSettings(target.engine, settings);

  if (target.engine === "claude") {
    clearClaudeLegacyMcpServers();
  }

  return target;
}

export function deleteRuntimeMcpServer(
  engine: string | null | undefined,
  name: string
): { target: RuntimeConfigTarget; deleted: boolean } {
  const target = getRuntimeConfigTarget(engine);
  const current = readRuntimeMcpServers(target.engine).mcpServers;

  if (!current[name]) {
    return { target, deleted: false };
  }

  delete current[name];
  writeRuntimeMcpServers(target.engine, current);

  return { target, deleted: true };
}

export interface CliEngineDefaults {
  model: string;
  reasoningEffort: string;
  providerId: string;
}

export function getCliDefaultsForEngine(engine?: string | null): CliEngineDefaults {
  const engineType = normalizeEngineType(engine);
  const settings = readRuntimeSettings(engineType);
  
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  
  switch (engineType) {
    case 'claude':
      model = typeof settings.model === 'string' ? settings.model : undefined;
      reasoningEffort = typeof settings.reasoningEffort === 'string' ? settings.reasoningEffort : undefined;
      break;
    case 'codex':
      model = typeof settings.model === 'string' ? settings.model : undefined;
      reasoningEffort = typeof settings.model_reasoning_effort === 'string' ? settings.model_reasoning_effort : undefined;
      break;
    case 'gemini':
      model = typeof settings.model === 'string' ? settings.model : undefined;
      break;
  }
  
  if (!model) {
    if (engineType === 'codex') model = 'gpt-5.3-codex';
    else if (engineType === 'gemini') model = 'auto-gemini-2.5';
    else model = 'sonnet';
  }
  if (!reasoningEffort) {
    if (engineType === 'codex') reasoningEffort = 'medium';
    else if (engineType === 'claude') reasoningEffort = 'high';
    else reasoningEffort = '';
  }
  
  const providerId = (engineType === 'codex' || engineType === 'gemini') ? 'env' : '';
  
  return { model, reasoningEffort, providerId };
}
