import { NextRequest, NextResponse } from "next/server";
import { getOAuthSessionManager } from "@/lib/oauth-session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { session_id?: string; code?: string };
  const sessionId = body.session_id?.trim();
  const code = body.code?.trim();

  if (!sessionId || !code) {
    return NextResponse.json(
      { error: "session_id and code are required" },
      { status: 400 },
    );
  }

  const manager = getOAuthSessionManager();
  const submitted = manager.submitCode(sessionId, code);

  if (!submitted) {
    return NextResponse.json(
      { error: "Session not found or process not running" },
      { status: 404 },
    );
  }

  return NextResponse.json({ submitted: true });
}
