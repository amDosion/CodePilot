import { NextRequest, NextResponse } from "next/server";
import { getOAuthSessionManager } from "@/lib/oauth-session-manager";
import { isValidEngine, type CliEngine } from "@/lib/cli-auth-utils";

interface StartOAuthBody {
  engine: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as StartOAuthBody;
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

    const manager = getOAuthSessionManager();
    const sessionId = manager.startOAuth(engine as CliEngine);

    return NextResponse.json({
      session_id: sessionId,
      status: "starting",
    });
  } catch (err) {
    console.error("[cli-auth/oauth/start] Error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to start OAuth login",
      },
      { status: 500 },
    );
  }
}
