import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import { runRemoteCommand } from '@/lib/remote-ssh';
import { normalizeEngineType } from '@/lib/engine-defaults';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RemoteConfigTarget {
  engine: string;
  format: 'json' | 'toml';
  path: string;
}

function getRemoteConfigTarget(engine?: string | null): RemoteConfigTarget {
  const resolved = normalizeEngineType(engine);
  if (resolved === 'codex') {
    return { engine: resolved, format: 'toml', path: '~/.codex/config.toml' };
  }
  if (resolved === 'gemini') {
    return { engine: resolved, format: 'json', path: '~/.gemini/settings.json' };
  }
  return { engine: 'claude', format: 'json', path: '~/.claude/settings.json' };
}

/** POST: Read remote CLI settings */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { connection_id?: string; engine?: string };
    const connectionId = (body.connection_id || '').trim();
    if (!connectionId) {
      return NextResponse.json({ error: 'connection_id is required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    const target = getRemoteConfigTarget(body.engine);

    const result = await runRemoteCommand(
      connection,
      `cat ${target.path} 2>/dev/null || echo '{}'`,
      { timeoutMs: 10000 },
    );

    let settings: Record<string, unknown> = {};
    const raw = result.stdout.trim();
    if (raw) {
      try {
        settings = JSON.parse(raw);
      } catch {
        // For TOML, return raw content; frontend can parse
        settings = { _raw: raw };
      }
    }

    return NextResponse.json({
      engine: target.engine,
      format: target.format,
      path: target.path,
      settings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read remote settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** PUT: Write remote CLI settings */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json() as {
      connection_id?: string;
      engine?: string;
      settings?: Record<string, unknown>;
    };

    const connectionId = (body.connection_id || '').trim();
    if (!connectionId || !body.settings) {
      return NextResponse.json({ error: 'connection_id and settings are required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    const target = getRemoteConfigTarget(body.engine);
    const dirPath = target.path.replace(/\/[^/]+$/, '');
    const content = JSON.stringify(body.settings, null, 2);

    await runRemoteCommand(
      connection,
      `mkdir -p ${dirPath} && cat > ${target.path} << 'CODEPILOT_EOF'\n${content}\nCODEPILOT_EOF`,
      { timeoutMs: 10000 },
    );

    return NextResponse.json({
      success: true,
      engine: target.engine,
      format: target.format,
      path: target.path,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to write remote settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
