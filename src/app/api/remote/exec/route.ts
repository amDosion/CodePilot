import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection, markRemoteConnectionError, markRemoteConnectionSuccess } from '@/lib/remote-connections';
import { runRemoteCommand } from '@/lib/remote-ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let connectionId = '';
  try {
    const body = await request.json() as {
      connection_id?: string;
      command?: string;
      cwd?: string;
      timeout_ms?: number;
    };

    connectionId = (body.connection_id || '').trim();
    if (!connectionId || !body.command?.trim()) {
      return NextResponse.json({ error: 'connection_id and command are required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    const result = await runRemoteCommand(connection, body.command.trim(), {
      cwd: body.cwd,
      timeoutMs: body.timeout_ms,
    });
    markRemoteConnectionSuccess(connection.id);
    return NextResponse.json({
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Remote command failed';
    if (connectionId) {
      markRemoteConnectionError(connectionId, message);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
