import { spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import { buildClaudeSpawnCommand } from "@/lib/claude-cli";
import { buildCodexSpawnCommand } from "@/lib/codex-cli";
import { buildGeminiSpawnCommand } from "@/lib/gemini-cli";
import { type CliEngine } from "@/lib/cli-auth-utils";

export type OAuthSessionStatus =
  | "starting"
  | "url_ready"
  | "waiting"
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
  subprocess?: ChildProcess;
}

// Serializable subset returned to clients
export interface OAuthSessionInfo {
  id: string;
  engine: string;
  status: OAuthSessionStatus;
  authUrl?: string;
  error?: string;
  createdAt: number;
}

const URL_PATTERNS = [
  /https?:\/\/[^\s]*console\.anthropic\.com[^\s]*/,
  /https?:\/\/[^\s]*claude\.com[^\s]*oauth[^\s]*/,
  /https?:\/\/[^\s]*auth\.openai\.com[^\s]*/,
  /https?:\/\/[^\s]*accounts\.google\.com[^\s]*/,
  /https?:\/\/[^\s]*login\.microsoftonline\.com[^\s]*/,
  // Generic OAuth URLs that CLIs might print
  /https?:\/\/[^\s]*oauth[^\s]*/i,
  /https?:\/\/[^\s]*authorize[^\s]*/i,
];

function extractOAuthUrl(text: string): string | undefined {
  for (const pattern of URL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // Clean trailing punctuation that may be captured
      return match[0].replace(/[)>\]'"]+$/, "");
    }
  }
  return undefined;
}

class OAuthSessionManager {
  private sessions = new Map<string, OAuthSession>();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Run cleanup every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    // Prevent timer from keeping the process alive
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
    // Kill any existing session for the same engine
    for (const [existingId, existing] of this.sessions) {
      if (existing.engine === engine) {
        if (existing.subprocess && !existing.subprocess.killed) {
          try { existing.subprocess.kill("SIGKILL"); } catch { /* */ }
        }
        this.sessions.delete(existingId);
      }
    }

    const session: OAuthSession = {
      id,
      engine,
      status: "starting",
      createdAt: Date.now(),
    };

    this.sessions.set(id, session);

    try {
      this.spawnLoginProcess(session);
    } catch (err) {
      session.status = "failed";
      session.error =
        err instanceof Error ? err.message : "Failed to start login process";
      console.error(
        `[oauth-session] Failed to start ${engine} login:`,
        err,
      );
    }

    return id;
  }

  getSession(id: string): OAuthSessionInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    // Check if expired
    if (Date.now() - session.createdAt > this.TTL_MS) {
      this.terminateSession(session);
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

  cancelSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.terminateSession(session);
    this.sessions.delete(id);
    return true;
  }

  submitCode(sessionId: string, code: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.subprocess || session.subprocess.killed) {
      return false;
    }
    try {
      session.subprocess.stdin?.write(code + "\n");
      return true;
    } catch {
      return false;
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > this.TTL_MS) {
        this.terminateSession(session);
        this.sessions.delete(id);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [, session] of this.sessions) {
      this.terminateSession(session);
    }
    this.sessions.clear();
  }

  private terminateSession(session: OAuthSession): void {
    if (session.subprocess && !session.subprocess.killed) {
      try {
        session.subprocess.kill("SIGTERM");
      } catch {
        // Process may already be dead
      }
    }
  }

  private spawnLoginProcess(session: OAuthSession): void {
    const spawnCmd = this.buildLoginCommand(session.engine);

    const env: NodeJS.ProcessEnv = {
      ...spawnCmd.env,
      BROWSER: "echo",
      NO_COLOR: "1",
      // Prevent interactive prompts
      CI: "1",
    };

    const child = spawn(spawnCmd.command, spawnCmd.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });

    session.subprocess = child;
    session.status = "waiting";

    let outputBuffer = "";

    const processOutput = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      outputBuffer += text;
      console.log(
        `[oauth-session] [${session.engine}] output: ${text.trim()}`,
      );

      if (session.status !== "url_ready" && session.status !== "completed") {
        const url = extractOAuthUrl(outputBuffer);
        if (url) {
          session.authUrl = url;
          session.status = "url_ready";
          console.log(
            `[oauth-session] [${session.engine}] OAuth URL found: ${url}`,
          );
        }
      }
    };

    if (child.stdout) {
      child.stdout.on("data", processOutput);
    }
    if (child.stderr) {
      child.stderr.on("data", processOutput);
    }

    child.on("close", (code) => {
      console.log(
        `[oauth-session] [${session.engine}] process exited with code ${code}`,
      );
      if (code === 0) {
        session.status = "completed";
      } else if (
        session.status !== "url_ready" &&
        session.status !== "completed"
      ) {
        session.status = "failed";
        session.error = `Login process exited with code ${code}. Output: ${outputBuffer.slice(0, 500)}`;
      }
      // If status is url_ready, keep it - the user may still complete the flow
      // The process exits because BROWSER=echo just prints the URL
    });

    child.on("error", (err) => {
      console.error(
        `[oauth-session] [${session.engine}] process error:`,
        err,
      );
      session.status = "failed";
      session.error = `Process error: ${err.message}`;
    });

    // Timeout
    setTimeout(() => {
      if (session.status === "starting" || session.status === "waiting") {
        session.status = "failed";
        session.error = "Login timed out after 5 minutes";
        this.terminateSession(session);
      }
    }, this.TTL_MS);
  }

  private buildLoginCommand(engine: CliEngine): {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  } {
    switch (engine) {
      case "claude":
        return buildClaudeSpawnCommand(["auth", "login"]);
      case "codex":
        return buildCodexSpawnCommand(["login"]);
      case "gemini":
        return buildGeminiSpawnCommand(["auth", "login"]);
      default: {
        // Exhaustive check
        const _exhaustive: never = engine;
        throw new Error(`Unknown engine: ${String(_exhaustive)}`);
      }
    }
  }
}

// Singleton instance — use globalThis to survive Next.js HMR reloads
const GLOBAL_KEY = '__codepilot_oauth_session_manager__';

export function getOAuthSessionManager(): OAuthSessionManager {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new OAuthSessionManager();
  }
  return g[GLOBAL_KEY] as OAuthSessionManager;
}
