import { NextRequest, NextResponse } from 'next/server';
import {
  deleteRemoteConnection,
  getRemoteConnection,
  updateRemoteConnection,
} from '@/lib/remote-connections';
import type { UpdateRemoteConnectionRequest } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const connection = getRemoteConnection(id);
  if (!connection) {
    return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
  }
  return NextResponse.json({ connection });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json() as UpdateRemoteConnectionRequest;
    const connection = updateRemoteConnection(id, body);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }
    return NextResponse.json({ connection });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update remote connection' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const deleted = deleteRemoteConnection(id);
  if (!deleted) {
    return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
