import { NextRequest, NextResponse } from 'next/server';
import { closeRemoteTunnel } from '@/lib/remote-tunnels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const closed = closeRemoteTunnel(id);
  if (!closed) {
    return NextResponse.json({ error: 'SSH tunnel not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
