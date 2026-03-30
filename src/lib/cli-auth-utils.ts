import fs from "fs";
import path from "path";
import os from "os";
import { getAllProviders } from "@/lib/db";
import type { ApiProvider } from "@/types";

export type CliAuthMethod = "oauth" | "api-key" | "env-var" | "none";
export type CliAuthStatus =
  | "authenticated"
  | "expired"
  | "not-configured"
  | "error";
export type CliEngine = "claude" | "codex" | "gemini";

export interface CliAuthInfo {
  engine: string;
  status: CliAuthStatus;
  method: CliAuthMethod;
  account?: { email?: string; plan?: string };
  lastUpdated?: string;
  maskedKey?: string;
}

function maskToken(value: string): string {
  if (value.length <= 4) return "****";
  return "***" + value.slice(-4);
}

function fileModTime(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.mtime.toISOString();
  } catch {
    return undefined;
  }
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Helper to extract OAuth data from Claude credentials which may be nested
// under `claudeAiOauth` or at top level
interface ClaudeOAuthData {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
}

function extractClaudeOAuthData(
  creds: Record<string, unknown>,
): ClaudeOAuthData | null {
  // Check nested structure first: { claudeAiOauth: { accessToken, ... } }
  if (
    creds.claudeAiOauth &&
    typeof creds.claudeAiOauth === "object" &&
    creds.claudeAiOauth !== null
  ) {
    const nested = creds.claudeAiOauth as Record<string, unknown>;
    if (
      typeof nested.accessToken === "string" ||
      typeof nested.refreshToken === "string"
    ) {
      return {
        accessToken: nested.accessToken as string | undefined,
        refreshToken: nested.refreshToken as string | undefined,
        expiresAt: nested.expiresAt as number | undefined,
        subscriptionType: nested.subscriptionType as string | undefined,
      };
    }
  }

  // Check top-level structure: { accessToken, ... } or { access_token, ... }
  const accessToken =
    (creds.accessToken as string | undefined) ??
    (creds.access_token as string | undefined);
  const refreshToken =
    (creds.refreshToken as string | undefined) ??
    (creds.refresh_token as string | undefined);

  if (accessToken || refreshToken) {
    return {
      accessToken,
      refreshToken,
      expiresAt: creds.expiresAt as number | undefined,
      subscriptionType: creds.subscriptionType as string | undefined,
    };
  }

  return null;
}

// ---- Claude ----
function detectClaudeAuth(): CliAuthInfo {
  const home = os.homedir();
  const base: CliAuthInfo = {
    engine: "claude",
    status: "not-configured",
    method: "none",
  };

  // 1. OAuth credentials file
  const credPath = path.join(home, ".claude", ".credentials.json");
  try {
    const creds = safeReadJson(credPath);
    if (creds) {
      const oauthData = extractClaudeOAuthData(creds);
      if (oauthData) {
        const token = oauthData.accessToken ?? "";
        // Check if token is expired
        let status: CliAuthStatus = "authenticated";
        if (oauthData.expiresAt && oauthData.expiresAt < Date.now()) {
          // Has refresh token means we can still refresh
          if (!oauthData.refreshToken) {
            status = "expired";
          }
        }
        return {
          ...base,
          status,
          method: "oauth",
          maskedKey: token ? maskToken(token) : undefined,
          lastUpdated: fileModTime(credPath),
          account: {
            plan: oauthData.subscriptionType ?? undefined,
          },
        };
      }
    }
  } catch {
    // fall through
  }

  // 2. Environment variable
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) {
    return {
      ...base,
      status: "authenticated",
      method: "env-var",
      maskedKey: maskToken(envKey),
    };
  }

  // 3. Provider DB
  try {
    const providers = getAllProviders();
    const anthropicProvider = providers.find(
      (p: ApiProvider) =>
        p.provider_type === "anthropic" && p.api_key && p.api_key.length > 0,
    );
    if (anthropicProvider) {
      return {
        ...base,
        status: "authenticated",
        method: "api-key",
        maskedKey: maskToken(anthropicProvider.api_key),
      };
    }
  } catch {
    // DB not available
  }

  return base;
}

// ---- Codex ----
function detectCodexAuth(): CliAuthInfo {
  const home = os.homedir();
  const base: CliAuthInfo = {
    engine: "codex",
    status: "not-configured",
    method: "none",
  };

  // 1. Check Codex app-server account (covers keyring + auth.json + all auth modes)
  try {
    const { execFileSync } = require("child_process") as typeof import("child_process");
    const configPath = path.join(home, ".codex", "config.toml");
    if (fs.existsSync(configPath)) {
      // Codex stores auth in keyring or auth.json — check config.toml for evidence of login
      const configContent = fs.readFileSync(configPath, "utf-8");
      // If approvals_reviewer = "user" it means the CLI is configured and likely logged in
      const hasApprovalReviewer = configContent.includes("approvals_reviewer");
      // Check for auth.json which exists after successful auth
      const authFilePath = path.join(home, ".codex", "auth.json");
      if (hasApprovalReviewer && fs.existsSync(authFilePath)) {
        const cacheModTime = fileModTime(authFilePath);
        return {
          ...base,
          status: "authenticated",
          method: "oauth",
          lastUpdated: cacheModTime,
          account: {
            plan: "ChatGPT",
          },
        };
      }
    }
  } catch {
    // fall through
  }

  // 2. OAuth auth.json (file-based storage, non-keyring mode)
  const authPath = path.join(home, ".codex", "auth.json");
  try {
    const auth = safeReadJson(authPath);
    if (auth) {
      const isChatGpt = auth.auth_mode === "chatgpt";
      // Codex stores tokens nested: { tokens: { access_token, refresh_token } }
      const tokens = (auth.tokens && typeof auth.tokens === "object")
        ? (auth.tokens as Record<string, unknown>)
        : null;
      const hasTokens =
        typeof auth.access_token === "string" ||
        typeof auth.accessToken === "string" ||
        typeof auth.token === "string" ||
        typeof tokens?.access_token === "string";
      if (isChatGpt && hasTokens) {
        const token =
          (tokens?.access_token as string | undefined) ??
          (auth.access_token as string | undefined) ??
          (auth.accessToken as string | undefined) ??
          (auth.token as string | undefined) ??
          "";
        return {
          ...base,
          status: "authenticated",
          method: "oauth",
          maskedKey: token ? maskToken(token) : undefined,
          lastUpdated: fileModTime(authPath),
          account: {
            email: (auth.email as string | undefined) ?? undefined,
            plan: "ChatGPT",
          },
        };
      }
    }
  } catch {
    // fall through
  }

  // 3. Environment variable
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    return {
      ...base,
      status: "authenticated",
      method: "env-var",
      maskedKey: maskToken(envKey),
    };
  }

  return base;
}

// ---- Gemini ----
function detectGeminiAuth(): CliAuthInfo {
  const home = os.homedir();
  const base: CliAuthInfo = {
    engine: "gemini",
    status: "not-configured",
    method: "none",
  };

  // 1. OAuth credentials
  const oauthCredsPath = path.join(home, ".gemini", "oauth_creds.json");
  const googleAccountsPath = path.join(
    home,
    ".gemini",
    "google_accounts.json",
  );
  try {
    const oauthCreds = safeReadJson(oauthCredsPath);
    if (oauthCreds) {
      const hasTokens =
        typeof oauthCreds.access_token === "string" ||
        typeof oauthCreds.refresh_token === "string";
      if (hasTokens) {
        const token = (oauthCreds.access_token as string | undefined) ?? "";
        let email: string | undefined;
        try {
          const accounts = safeReadJson(googleAccountsPath);
          if (accounts && Array.isArray(accounts.accounts)) {
            const first = accounts.accounts[0] as
              | Record<string, unknown>
              | undefined;
            email = (first?.email as string | undefined) ?? undefined;
          }
        } catch {
          // ignore
        }
        return {
          ...base,
          status: "authenticated",
          method: "oauth",
          maskedKey: token ? maskToken(token) : undefined,
          lastUpdated: fileModTime(oauthCredsPath),
          account: { email },
        };
      }
    }
  } catch {
    // fall through
  }

  // 2. Environment variables
  const geminiKey = process.env.GEMINI_API_KEY;
  const googleKey = process.env.GOOGLE_API_KEY;
  const envKey = geminiKey || googleKey;
  if (envKey) {
    return {
      ...base,
      status: "authenticated",
      method: "env-var",
      maskedKey: maskToken(envKey),
    };
  }

  // 3. Gemini .env file
  const geminiEnvPath = path.join(home, ".gemini", ".env");
  try {
    if (fs.existsSync(geminiEnvPath)) {
      const content = fs.readFileSync(geminiEnvPath, "utf8");
      const keyMatch = content.match(
        /(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*(.+)/,
      );
      if (keyMatch && keyMatch[1]) {
        const val = keyMatch[1].trim().replace(/^["']|["']$/g, "");
        if (val.length > 0) {
          return {
            ...base,
            status: "authenticated",
            method: "api-key",
            maskedKey: maskToken(val),
            lastUpdated: fileModTime(geminiEnvPath),
          };
        }
      }
    }
  } catch {
    // fall through
  }

  return base;
}

// ---- Public API ----
const ENGINE_DETECTORS: Record<CliEngine, () => CliAuthInfo> = {
  claude: detectClaudeAuth,
  codex: detectCodexAuth,
  gemini: detectGeminiAuth,
};

export function detectAuthForEngine(engine: CliEngine): CliAuthInfo {
  const detector = ENGINE_DETECTORS[engine];
  if (!detector) {
    return {
      engine,
      status: "error",
      method: "none",
    };
  }
  try {
    return detector();
  } catch (err) {
    console.error(`[cli-auth] Error detecting auth for ${engine}:`, err);
    return {
      engine,
      status: "error",
      method: "none",
    };
  }
}

export function detectAuthForAllEngines(): Record<CliEngine, CliAuthInfo> {
  return {
    claude: detectAuthForEngine("claude"),
    codex: detectAuthForEngine("codex"),
    gemini: detectAuthForEngine("gemini"),
  };
}

export const VALID_ENGINES: readonly CliEngine[] = [
  "claude",
  "codex",
  "gemini",
] as const;

export function isValidEngine(engine: string): engine is CliEngine {
  return (VALID_ENGINES as readonly string[]).includes(engine);
}
