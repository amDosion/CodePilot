import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { isValidEngine, type CliEngine } from "@/lib/cli-auth-utils";

interface LogoutBody {
  engine: string;
}

interface CredentialFile {
  path: string;
  description: string;
}

function getCredentialFiles(engine: CliEngine): CredentialFile[] {
  const home = os.homedir();

  switch (engine) {
    case "claude":
      return [
        {
          path: path.join(home, ".claude", ".credentials.json"),
          description: "Claude OAuth credentials",
        },
      ];
    case "codex":
      return [
        {
          path: path.join(home, ".codex", "auth.json"),
          description: "Codex OAuth credentials",
        },
        {
          path: path.join(home, ".codex", "models_cache.json"),
          description: "Codex models cache",
        },
      ];
    case "gemini":
      return [
        {
          path: path.join(home, ".gemini", "oauth_creds.json"),
          description: "Gemini OAuth credentials",
        },
        {
          path: path.join(home, ".gemini", "google_accounts.json"),
          description: "Gemini Google accounts",
        },
        {
          path: path.join(home, ".gemini", "settings.json"),
          description: "Gemini settings",
        },
      ];
    default: {
      const _exhaustive: never = engine;
      throw new Error(`Unknown engine: ${String(_exhaustive)}`);
    }
  }
}

function safeDeleteFile(filePath: string): { deleted: boolean; error?: string } {
  try {
    if (!fs.existsSync(filePath)) {
      return { deleted: false, error: "File does not exist" };
    }
    fs.unlinkSync(filePath);
    return { deleted: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[cli-auth/logout] Failed to delete ${filePath}:`, err);
    return { deleted: false, error: message };
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as LogoutBody;
    const { engine } = body;

    if (!engine || typeof engine !== "string") {
      return NextResponse.json(
        { error: "Missing required field: engine" },
        { status: 400 },
      );
    }

    if (!isValidEngine(engine)) {
      return NextResponse.json(
        {
          error: `Invalid engine: ${engine}. Must be one of: claude, codex, gemini`,
        },
        { status: 400 },
      );
    }

    const credFiles = getCredentialFiles(engine as CliEngine);
    const results: Array<{
      file: string;
      description: string;
      deleted: boolean;
      error?: string;
    }> = [];

    for (const cred of credFiles) {
      const result = safeDeleteFile(cred.path);
      results.push({
        file: cred.path,
        description: cred.description,
        ...result,
      });
    }

    const anyDeleted = results.some((r) => r.deleted);
    const anyErrors = results.some((r) => r.error && r.deleted === false && r.error !== "File does not exist");

    return NextResponse.json({
      engine,
      success: anyDeleted || !anyErrors,
      results,
    });
  } catch (err) {
    console.error("[cli-auth/logout] Error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to process logout",
      },
      { status: 500 },
    );
  }
}
