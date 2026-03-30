import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import { inspectRemoteRuntimes } from '@/lib/remote-runtime-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { connection_id?: string };
    const connectionId = (body.connection_id || '').trim();
    if (!connectionId) {
      return NextResponse.json({ error: 'connection_id is required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    const runtimes = await inspectRemoteRuntimes(connection);

    return NextResponse.json({
      connected: runtimes.claude.available || runtimes.codex.available || runtimes.gemini.available,
      engines: {
        claude: {
          available: runtimes.claude.available,
          ready: runtimes.claude.available,
          version: runtimes.claude.version,
          detail: runtimes.claude.detail,
        },
        codex: {
          available: runtimes.codex.available,
          ready: runtimes.codex.available,
          version: runtimes.codex.version,
          detail: runtimes.codex.detail,
        },
        gemini: {
          available: runtimes.gemini.available,
          ready: runtimes.gemini.available,
          version: runtimes.gemini.version,
          detail: runtimes.gemini.detail,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to detect remote runtimes';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
