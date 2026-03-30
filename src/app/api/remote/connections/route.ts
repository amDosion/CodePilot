import { NextRequest, NextResponse } from 'next/server';
import {
  createRemoteConnection,
  listRemoteConnections,
} from '@/lib/remote-connections';
import type { CreateRemoteConnectionRequest, RemoteConnectionsResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json<RemoteConnectionsResponse>({
    connections: listRemoteConnections(),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as CreateRemoteConnectionRequest;
    if (!body.name?.trim() || !body.host?.trim()) {
      return NextResponse.json({ error: 'name and host are required' }, { status: 400 });
    }
    const connection = createRemoteConnection(body);
    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create remote connection' },
      { status: 500 },
    );
  }
}
