import { NextRequest, NextResponse } from "next/server";
import type {
  MCPServerConfig,
  MCPConfigResponse,
  ErrorResponse,
  SuccessResponse,
} from "@/types";
import {
  readRuntimeMcpServers,
  writeRuntimeMcpServers,
} from "@/lib/runtime-config";

function resolveEngine(request: NextRequest, body?: unknown): string | undefined {
  const fromQuery = request.nextUrl.searchParams.get("engine_type")
    || request.nextUrl.searchParams.get("engine");

  if (fromQuery) {
    return fromQuery;
  }

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record.engine_type === "string") return record.engine_type;
    if (typeof record.engine === "string") return record.engine;
  }

  return undefined;
}

export async function GET(
  request: NextRequest
): Promise<NextResponse<(MCPConfigResponse & { engine: string; format: string; path: string }) | ErrorResponse>> {
  try {
    const runtime = readRuntimeMcpServers(resolveEngine(request));
    return NextResponse.json({
      engine: runtime.engine,
      format: runtime.format,
      path: runtime.path,
      mcpServers: runtime.mcpServers,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read MCP config" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  try {
    const body = await request.json();
    const { mcpServers } = body as { mcpServers: Record<string, MCPServerConfig> };

    writeRuntimeMcpServers(resolveEngine(request, body), mcpServers || {});

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update MCP config" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  try {
    const body = await request.json();
    const { name, server } = body as { name: string; server: MCPServerConfig };
    const isRemoteServer = server?.type === "http" || server?.type === "sse";

    if (!name || !server || (!isRemoteServer && !server.command) || (isRemoteServer && !server.url)) {
      return NextResponse.json(
        { error: "Name and server configuration are required" },
        { status: 400 }
      );
    }

    const engine = resolveEngine(request, body);
    const current = readRuntimeMcpServers(engine).mcpServers;
    if (current[name]) {
      return NextResponse.json(
        { error: `MCP server "${name}" already exists` },
        { status: 409 }
      );
    }

    current[name] = server;
    writeRuntimeMcpServers(engine, current);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to add MCP server" },
      { status: 500 }
    );
  }
}
