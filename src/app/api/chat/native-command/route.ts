import { NextRequest, NextResponse } from 'next/server';
import { runClaudeNativeCommand } from '@/lib/agent/claude-native-controller';
import { runCodexNativeCommand } from '@/lib/agent/codex-native-controller';
import { runGeminiNativeCommand } from '@/lib/agent/gemini-native-controller';
import { normalizeEngineType } from '@/lib/engine-defaults';
import type { NativeCommandControllerRequest } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNativeCommandRequest(body: Record<string, unknown>): body is Record<string, unknown> & NativeCommandControllerRequest {
  return typeof body.command_name === 'string'
    && typeof body.command === 'string'
    && typeof body.engine_type === 'string';
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!isRecord(body) || !isNativeCommandRequest(body)) {
      return NextResponse.json(
        {
          handled: false,
          error: 'INVALID_REQUEST',
          message: 'Request body must include command, command_name, and engine_type.',
        },
        { status: 400 },
      );
    }

    const engineType = normalizeEngineType(body.engine_type);
    const result = engineType === 'codex'
      ? await runCodexNativeCommand(body)
      : engineType === 'gemini'
        ? await runGeminiNativeCommand(body)
        : engineType === 'claude'
          ? await runClaudeNativeCommand(body)
          : {
              handled: false,
              error: 'UNSUPPORTED_ENGINE',
              message: `Native command controller is not available for engine "${engineType}".`,
            };
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[POST /api/chat/native-command] Error:', message);
    return NextResponse.json(
      {
        handled: false,
        error: 'INTERNAL_ERROR',
        message: 'Native command controller failed.',
      },
      { status: 500 },
    );
  }
}
