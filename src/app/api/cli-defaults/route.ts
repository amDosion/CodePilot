import { NextRequest, NextResponse } from 'next/server';
import { normalizeEngineType } from '@/lib/engine-defaults';
import { readRuntimeSettings } from '@/lib/runtime-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/cli-defaults?engine_type=claude
 *
 * Returns the current CLI config file values for the given engine.
 * Frontend uses these as initial defaults instead of hardcoded values.
 */
export async function GET(request: NextRequest) {
  const engineType = normalizeEngineType(request.nextUrl.searchParams.get('engine_type'));

  try {
    const settings = readRuntimeSettings(engineType);

    let model: string | undefined;
    let reasoningEffort: string | undefined;
    let permissionMode: string | undefined;

    switch (engineType) {
      case 'claude':
        model = typeof settings.model === 'string' ? settings.model : undefined;
        reasoningEffort = typeof settings.reasoningEffort === 'string' ? settings.reasoningEffort : undefined;
        permissionMode = typeof settings.permissionMode === 'string' ? settings.permissionMode : undefined;
        break;
      case 'codex':
        model = typeof settings.model === 'string' ? settings.model : undefined;
        reasoningEffort = typeof settings.model_reasoning_effort === 'string' ? settings.model_reasoning_effort : undefined;
        permissionMode = typeof settings.approval_policy === 'string' ? settings.approval_policy : undefined;
        break;
      case 'gemini': {
        model = typeof settings.model === 'string' ? settings.model : undefined;
        const perms = settings.permissions;
        if (perms && typeof perms === 'object' && 'defaultMode' in perms) {
          permissionMode = String((perms as Record<string, unknown>).defaultMode);
        }
        break;
      }
    }

    return NextResponse.json({
      engine: engineType,
      model: model || null,
      reasoningEffort: reasoningEffort || null,
      permissionMode: permissionMode || null,
    });
  } catch {
    return NextResponse.json({
      engine: engineType,
      model: null,
      reasoningEffort: null,
      permissionMode: null,
    });
  }
}
