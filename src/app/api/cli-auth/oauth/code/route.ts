import { NextRequest, NextResponse } from "next/server";
import { getOAuthSessionManager } from "@/lib/oauth-session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      session_id?: string;
      code?: string;
    };
    const sessionId = body.session_id?.trim();
    const code = body.code?.trim();

    if (!sessionId || !code) {
      return NextResponse.json(
        { error: "session_id and code are required" },
        { status: 400 },
      );
    }

    const manager = getOAuthSessionManager();
    const result = await manager.submitCode(sessionId, code);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? "Token exchange failed" },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[cli-auth/oauth/code] Error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to submit code",
      },
      { status: 500 },
    );
  }
}
