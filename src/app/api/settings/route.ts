import { NextRequest, NextResponse } from "next/server";
import {
  readRuntimeSettings,
  writeRuntimeSettings,
  getRuntimeConfigTarget,
} from "@/lib/runtime-config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(request: NextRequest) {
  try {
    const target = getRuntimeConfigTarget(request.nextUrl.searchParams.get("engine"));
    const settings = readRuntimeSettings(target.engine);

    return NextResponse.json({
      engine: target.engine,
      format: target.format,
      path: target.path,
      settings,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to read settings" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const settings = isRecord(body) && isRecord(body.settings) ? body.settings : null;

    if (!settings) {
      return NextResponse.json(
        { error: "Invalid settings data" },
        { status: 400 }
      );
    }

    const target = writeRuntimeSettings(
      isRecord(body) && typeof body.engine === "string" ? body.engine : undefined,
      settings
    );

    return NextResponse.json({
      success: true,
      engine: target.engine,
      format: target.format,
      path: target.path,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
