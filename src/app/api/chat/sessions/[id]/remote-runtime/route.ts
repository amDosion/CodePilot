import { NextRequest, NextResponse } from 'next/server';
import { normalizeEngineType } from '@/lib/engine-defaults';
import { getSession } from '@/lib/db';
import { getRemoteConnection, markRemoteConnectionError, markRemoteConnectionSuccess } from '@/lib/remote-connections';
import { inspectRemoteRuntimes } from '@/lib/remote-runtime-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<unknown> },
) {
  const { id } = await context.params as { id: string };
  const session = getSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (session.workspace_transport !== 'ssh_direct') {
    return NextResponse.json({ error: 'Session is not using a remote SSH workspace' }, { status: 400 });
  }
  if (!session.remote_connection_id || !session.remote_path || !session.working_directory) {
    return NextResponse.json({ error: 'Session remote workspace is incomplete' }, { status: 400 });
  }

  const connection = getRemoteConnection(session.remote_connection_id);
  if (!connection) {
    return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
  }

  try {
    const runtimes = await inspectRemoteRuntimes(connection);
    markRemoteConnectionSuccess(connection.id);
    return NextResponse.json({
      success: true,
      checked_at: new Date().toISOString(),
      current_engine: normalizeEngineType(session.engine_type || 'claude'),
      remote_path: session.remote_path,
      local_path: session.working_directory,
      runtimes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Remote runtime inspection failed';
    markRemoteConnectionError(connection.id, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
