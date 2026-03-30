import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import {
  getHealthMonitorState,
  checkConnectionHealth,
  startHealthMonitor,
  stopHealthMonitor,
  isHealthMonitorActive,
  triggerReconnect,
} from '@/lib/remote-health-monitor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/remote/connections/[id]/health
 * Returns current health state for a remote connection.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const connection = getRemoteConnection(id);
  if (!connection) {
    return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
  }

  const state = getHealthMonitorState(id);
  const active = isHealthMonitorActive(id);

  return NextResponse.json({
    connection_id: id,
    monitoring_active: active,
    ...state,
  });
}

/**
 * POST /api/remote/connections/[id]/health
 * Trigger an immediate health check, or start/stop monitoring.
 *
 * Body:
 *   { action: "check" }     — trigger one-off health check
 *   { action: "start" }     — start continuous health monitoring
 *   { action: "stop" }      — stop health monitoring
 *   { action: "reconnect" } — manually trigger reconnect
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const connection = getRemoteConnection(id);
  if (!connection) {
    return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
  }

  let body: { action?: string } = {};
  try {
    body = await request.json();
  } catch {
    // default to check
  }

  const action = body.action || 'check';

  switch (action) {
    case 'check': {
      const result = await checkConnectionHealth(id);
      return NextResponse.json({
        connection_id: id,
        health: result,
      });
    }

    case 'start': {
      startHealthMonitor(id);
      return NextResponse.json({
        connection_id: id,
        monitoring_active: true,
        state: getHealthMonitorState(id),
      });
    }

    case 'stop': {
      stopHealthMonitor(id);
      return NextResponse.json({
        connection_id: id,
        monitoring_active: false,
        state: getHealthMonitorState(id),
      });
    }

    case 'reconnect': {
      triggerReconnect(id);
      return NextResponse.json({
        connection_id: id,
        reconnecting: true,
        state: getHealthMonitorState(id),
      });
    }

    default:
      return NextResponse.json(
        { error: 'Unknown action. Use "check", "start", "stop", or "reconnect".' },
        { status: 400 },
      );
  }
}
