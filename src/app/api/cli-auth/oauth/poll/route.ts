import { NextRequest, NextResponse } from "next/server";
import { getOAuthSessionManager } from "@/lib/oauth-session-manager";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("session_id");

    if (!sessionId) {
      return NextResponse.json(
        { error: "Missing required query parameter: session_id" },
        { status: 400 },
      );
    }

    const manager = getOAuthSessionManager();
    const session = manager.getSession(sessionId);

    if (!session) {
      return NextResponse.json(
        { error: "Session not found or expired" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      status: session.status,
      auth_url: session.authUrl,
      device_code: session.deviceCode,
      error: session.error,
      engine: session.engine,
      created_at: session.createdAt,
    });
  } catch (err) {
    console.error("[cli-auth/oauth/poll] Error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to poll OAuth session",
      },
      { status: 500 },
    );
  }
}
