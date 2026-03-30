import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/db';
import { getRemoteConnection } from '@/lib/remote-connections';
import { getHealthMonitorState, isHealthMonitorActive } from '@/lib/remote-health-monitor';

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
  if (!session.remote_connection_id || !session.remote_path) {
    return NextResponse.json({ error: 'Session remote workspace is incomplete' }, { status: 400 });
  }

  const connection = getRemoteConnection(session.remote_connection_id);
  if (!connection) {
    return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
  }

  // Health monitor state
  const healthState = getHealthMonitorState(session.remote_connection_id);
  const monitoringActive = isHealthMonitorActive(session.remote_connection_id);

  return NextResponse.json({
    success: true,
    transport_mode: 'ssh_direct',
    remote_path: session.remote_path,
    checked_at: new Date().toISOString(),
    health: {
      monitoring_active: monitoringActive,
      ...healthState,
    },
  });
}
