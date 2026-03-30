import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import { listRemoteTunnels, openRemoteTunnel } from '@/lib/remote-tunnels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ tunnels: listRemoteTunnels() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      connection_id?: string;
      local_port?: number;
      remote_host?: string;
      remote_port?: number;
    };
    if (!body.connection_id || !body.local_port || !body.remote_host?.trim() || !body.remote_port) {
      return NextResponse.json({ error: 'connection_id, local_port, remote_host, and remote_port are required' }, { status: 400 });
    }

    const connection = getRemoteConnection(body.connection_id);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    const tunnel = await openRemoteTunnel(connection, {
      local_port: Number(body.local_port),
      remote_host: body.remote_host.trim(),
      remote_port: Number(body.remote_port),
    });
    return NextResponse.json({ tunnel }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to open SSH tunnel' },
      { status: 500 },
    );
  }
}
