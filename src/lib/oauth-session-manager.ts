import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { type CliEngine } from "@/lib/cli-auth-utils";
import { buildCodexSpawnCommand } from "@/lib/codex-cli";
import { buildGeminiSpawnCommand } from "@/lib/gemini-cli";

// ── Claude OAuth constants (extracted from Claude CLI binary) ───────────
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTH_ENDPOINT = "https://claude.com/cai/oauth/authorize";
const CLAUDE_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_REDIRECT_URI =
  "https://platform.claude.com/oauth/code/callback";
const CLAUDE_SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

// ── Types ───────────────────────────────────────────────────────────────
export type OAuthSessionStatus =
  | "starting"
  | "url_ready"
  | "waiting"
  | "exchanging"
  | "completed"
  | "failed"
  | "expired";

export interface OAuthSession {
  id: string;
  engine: CliEngine;
  status: OAuthSessionStatus;
  authUrl?: string;
  error?: string;
  createdAt: number;
  codeVerifier?: string;
  state?: string;
  subprocess?: ChildProcess;
}

export interface OAuthSessionInfo {
  id: string;
  engine: string;
  status: OAuthSessionStatus;
  authUrl?: string;
  error?: string;
  createdAt: number;
}

// ── PKCE helpers ────────────────────────────────────────────────────────
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// ── Token exchange ──────────────────────────────────────────────────────
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface ProfileInfo {
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

async function exchangeCodeForToken(
  code: string,
  state: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  // Matches exact Claude CLI implementation:
  //   H6.post(TOKEN_URL, body, {headers:{"Content-Type":"application/json"},timeout:15000})
  const res = await fetch(CLAUDE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT_URI,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: codeVerifier,
      state,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Token exchange failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }

  return (await res.json()) as TokenResponse;
}

async function fetchProfileInfo(
  accessToken: string,
): Promise<ProfileInfo> {
  try {
    const res = await fetch(
      "https://api.anthropic.com/api/oauth/profile",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        organization?: { organization_type?: string; rate_limit_tier?: string };
      };
      console.log("[oauth-session] Profile:", JSON.stringify({
        orgType: data.organization?.organization_type,
        rateLimitTier: data.organization?.rate_limit_tier,
      }));
      return {
        subscriptionType: data.organization?.organization_type ?? null,
        rateLimitTier: data.organization?.rate_limit_tier ?? null,
      };
    }
    console.error("[oauth-session] Profile fetch status:", res.status);
  } catch (err) {
    console.error("[oauth-session] Profile fetch error:", err);
  }
  return { subscriptionType: null, rateLimitTier: null };
}

// ── Credential storage ──────────────────────────────────────────────────
function storeClaudeCredentials(
  tokenRes: TokenResponse,
  profile: ProfileInfo,
): void {
  const claudeDir = path.join(os.homedir(), ".claude");
  const credPath = path.join(claudeDir, ".credentials.json");

  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  }

  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(credPath)) {
      existing = JSON.parse(fs.readFileSync(credPath, "utf8"));
    }
  } catch {
    // start fresh
  }

  const expiresAt = tokenRes.expires_in
    ? Date.now() + tokenRes.expires_in * 1000
    : 0;

  existing.claudeAiOauth = {
    accessToken: tokenRes.access_token,
    refreshToken: tokenRes.refresh_token ?? null,
    expiresAt,
    scopes: CLAUDE_SCOPE.split(" "),
    subscriptionType: profile.subscriptionType,
    rateLimitTier: profile.rateLimitTier,
  };

  fs.writeFileSync(credPath, JSON.stringify(existing, null, 2), {
    mode: 0o600,
  });
  console.log("[oauth-session] Claude credentials stored at", credPath);
}

// ── Extract code from user input ────────────────────────────────────────
function extractAuthCode(input: string): string {
  const trimmed = input.trim();

  // Case 1: full redirect URL with code parameter
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    if (code) return code;
  } catch {
    // not a URL
  }

  // Case 2: platform.claude.com callback page displays "code#state"
  // Split on # and take the code part
  if (trimmed.includes("#")) {
    return trimmed.split("#")[0];
  }

  // Case 3: raw authorization code string
  return trimmed;
}

// ── Session Manager ─────────────────────────────────────────────────────
class OAuthSessionManager {
  private sessions = new Map<string, OAuthSession>();
  private readonly TTL_MS = 10 * 60 * 1000;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    if (
      this.cleanupTimer &&
      typeof this.cleanupTimer === "object" &&
      "unref" in this.cleanupTimer
    ) {
      (this.cleanupTimer as NodeJS.Timeout).unref();
    }
  }

  startOAuth(engine: CliEngine): string {
    const id = crypto.randomUUID();

    for (const [existingId, existing] of this.sessions) {
      if (existing.engine === engine) {
        this.sessions.delete(existingId);
      }
    }

    if (engine === "claude") {
      return this.startClaudeOAuth(id);
    }

    // Gemini/Codex: use spawn-based approach (CLI handles its own OAuth flow)
    return this.startSpawnOAuth(id, engine);
  }

  private startClaudeOAuth(id: string): string {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    const params = new URLSearchParams({
      code: "true",
      client_id: CLAUDE_CLIENT_ID,
      response_type: "code",
      redirect_uri: CLAUDE_REDIRECT_URI,
      scope: CLAUDE_SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    const authUrl = `${CLAUDE_AUTH_ENDPOINT}?${params.toString()}`;

    const session: OAuthSession = {
      id,
      engine: "claude",
      status: "url_ready",
      authUrl,
      createdAt: Date.now(),
      codeVerifier,
      state,
    };

    this.sessions.set(id, session);
    console.log(`[oauth-session] Claude OAuth started, session=${id}`);
    return id;
  }

  private startSpawnOAuth(id: string, engine: CliEngine): string {
    const session: OAuthSession = {
      id,
      engine,
      status: "starting",
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);

    try {
      const spawnCmd = engine === "codex"
        ? buildCodexSpawnCommand(["login"])
        : buildGeminiSpawnCommand(["auth", "login"]);

      const child = spawn(spawnCmd.command, spawnCmd.args, {
        env: { ...spawnCmd.env, BROWSER: "echo", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: false,
      });

      session.subprocess = child;
      session.status = "waiting";

      let outputBuffer = "";

      const processOutput = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        outputBuffer += text;
        console.log(`[oauth-session] [${engine}] output: ${text.trim()}`);

        if (session.status !== "url_ready" && session.status !== "completed") {
          const url = this.extractOAuthUrl(outputBuffer);
          if (url) {
            session.authUrl = url;
            session.status = "url_ready";
          }
        }
      };

      child.stdout?.on("data", processOutput);
      child.stderr?.on("data", processOutput);

      child.on("close", (code) => {
        console.log(`[oauth-session] [${engine}] process exited with code ${code}`);
        if (code === 0) {
          session.status = "completed";
        } else if (session.status !== "url_ready" && session.status !== "completed") {
          session.status = "failed";
          session.error = `Login process exited with code ${code}`;
        }
      });

      child.on("error", (err) => {
        session.status = "failed";
        session.error = `Process error: ${err.message}`;
      });
    } catch (err) {
      session.status = "failed";
      session.error = err instanceof Error ? err.message : "Failed to start login";
    }

    return id;
  }

  private extractOAuthUrl(text: string): string | undefined {
    const patterns = [
      /https?:\/\/[^\s]*accounts\.google\.com[^\s]*/,
      /https?:\/\/[^\s]*auth\.openai\.com[^\s]*/,
      /https?:\/\/[^\s]*login\.microsoftonline\.com[^\s]*/,
      /https?:\/\/[^\s]*oauth[^\s]*/i,
      /https?:\/\/[^\s]*authorize[^\s]*/i,
      /https?:\/\/[^\s]*device[^\s]*/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[0].replace(/[)>\]'"]+$/, "");
    }
    return undefined;
  }

  getSession(id: string): OAuthSessionInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    if (Date.now() - session.createdAt > this.TTL_MS) {
      session.status = "expired";
    }

    return {
      id: session.id,
      engine: session.engine,
      status: session.status,
      authUrl: session.authUrl,
      error: session.error,
      createdAt: session.createdAt,
    };
  }

  async submitCode(
    sessionId: string,
    rawInput: string,
  ): Promise<{ success: boolean; error?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: "Session not found or expired" };
    }

    if (session.status !== "url_ready" && session.status !== "waiting") {
      return {
        success: false,
        error: `Invalid session status: ${session.status}`,
      };
    }

    const code = extractAuthCode(rawInput);
    if (!code) {
      return { success: false, error: "Could not extract authorization code" };
    }

    // Gemini/Codex: write code to subprocess stdin
    if (session.engine !== "claude") {
      if (!session.subprocess || session.subprocess.killed) {
        return { success: false, error: "Login process is not running" };
      }
      try {
        session.subprocess.stdin?.write(code + "\n");
        session.status = "exchanging";
        console.log(`[oauth-session] Wrote code to ${session.engine} stdin`);
        // Wait for process to complete
        return new Promise((resolve) => {
          const timeout = setTimeout(() => {
            if (session.status === "exchanging") {
              session.status = "completed";
            }
            resolve({ success: true });
          }, 10000);
          session.subprocess?.on("close", (exitCode) => {
            clearTimeout(timeout);
            if (exitCode === 0) {
              session.status = "completed";
              resolve({ success: true });
            } else {
              session.status = "failed";
              session.error = `Login process exited with code ${exitCode}`;
              resolve({ success: false, error: session.error });
            }
          });
        });
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Failed to write code" };
      }
    }

    // Claude: direct PKCE token exchange
    if (!session.codeVerifier || !session.state) {
      return { success: false, error: "Session missing PKCE state" };
    }

    session.status = "exchanging";
    console.log(`[oauth-session] Exchanging code for session=${sessionId}, raw_input_len=${rawInput.length}, extracted_code_len=${code.length}, code_prefix=${code.slice(0, 20)}...`);

    try {
      const tokenRes = await exchangeCodeForToken(
        code,
        session.state,
        session.codeVerifier,
      );
      const profile = await fetchProfileInfo(tokenRes.access_token);
      storeClaudeCredentials(tokenRes, profile);
      session.status = "completed";
      console.log(
        `[oauth-session] Claude OAuth completed for session=${sessionId}`,
      );
      return { success: true };
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Token exchange failed";
      session.status = "failed";
      session.error = msg;
      console.error(`[oauth-session] Token exchange failed:`, err);
      return { success: false, error: msg };
    }
  }

  cancelSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.subprocess && !session.subprocess.killed) {
      try { session.subprocess.kill("SIGTERM"); } catch { /* */ }
    }
    this.sessions.delete(id);
    return true;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > this.TTL_MS) {
        if (session.subprocess && !session.subprocess.killed) {
          try { session.subprocess.kill("SIGTERM"); } catch { /* */ }
        }
        this.sessions.delete(id);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}

const GLOBAL_KEY = "__codepilot_oauth_session_manager__";

export function getOAuthSessionManager(): OAuthSessionManager {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new OAuthSessionManager();
  }
  return g[GLOBAL_KEY] as OAuthSessionManager;
}
