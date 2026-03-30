import { NextRequest, NextResponse } from "next/server";
import type { ErrorResponse, SuccessResponse } from "@/types";
import { deleteRuntimeMcpServer } from "@/lib/runtime-config";

function resolveEngine(request: NextRequest): string | undefined {
  return request.nextUrl.searchParams.get("engine_type")
    || request.nextUrl.searchParams.get("engine")
    || undefined;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  try {
    const { name } = await params;
    const serverName = decodeURIComponent(name);
    const result = deleteRuntimeMcpServer(resolveEngine(request), serverName);

    if (!result.deleted) {
      return NextResponse.json(
        { error: `MCP server "${serverName}" not found` },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete MCP server" },
      { status: 500 }
    );
  }
}
