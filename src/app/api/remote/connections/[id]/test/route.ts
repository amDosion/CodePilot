import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection, markRemoteConnectionError, markRemoteConnectionSuccess } from '@/lib/remote-connections';
import { testRemoteConnection } from '@/lib/remote-ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const connection = getRemoteConnection(id);
  if (!connection) {
    return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
  }

  try {
    const result = await testRemoteConnection(connection);
    markRemoteConnectionSuccess(id);
    return NextResponse.json({ success: true, remote_pwd: result.remotePwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Remote connection test failed';
    markRemoteConnectionError(id, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
