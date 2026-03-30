import { NextRequest, NextResponse } from "next/server";
import {
  detectAuthForEngine,
  detectAuthForAllEngines,
  isValidEngine,
  type CliAuthInfo,
  type CliEngine,
} from "@/lib/cli-auth-utils";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const engineParam = searchParams.get("engine") || "all";

    if (engineParam === "all") {
      const engines = detectAuthForAllEngines();
      return NextResponse.json({ engines });
    }

    if (!isValidEngine(engineParam)) {
      return NextResponse.json(
        {
          error: `Invalid engine: ${engineParam}. Must be one of: claude, codex, gemini, all`,
        },
        { status: 400 }
      );
    }

    const info: CliAuthInfo = detectAuthForEngine(engineParam as CliEngine);
    return NextResponse.json({
      engines: { [engineParam]: info },
    });
  } catch (err) {
    console.error("[cli-auth/status] Error:", err);
    return NextResponse.json(
      { error: "Failed to detect CLI auth status" },
      { status: 500 }
    );
  }
}
