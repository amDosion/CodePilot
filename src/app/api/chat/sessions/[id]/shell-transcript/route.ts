import { NextRequest, NextResponse } from 'next/server';
import { getSession, getShellTranscriptEntries } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function resolveRemoteSession(id: string) {
  const session = getSession(id);
  if (!session) {
    return { error: NextResponse.json({ error: 'Session not found' }, { status: 404 }) } as const;
  }
  if (session.workspace_transport !== 'ssh_direct') {
    return { error: NextResponse.json({ error: 'Session is not using a remote SSH workspace' }, { status: 400 }) } as const;
  }
  return { session } as const;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<unknown> },
) {
  const { id } = await context.params as { id: string };
  const resolved = resolveRemoteSession(id);
  if ('error' in resolved) {
    return resolved.error;
  }

  const { searchParams } = new URL(request.url);
  const parsedLimit = Number.parseInt(searchParams.get('limit') || '100', 10);
  const parsedBefore = Number.parseInt(searchParams.get('before') || '', 10);

  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 100;
  const beforeRowId = Number.isFinite(parsedBefore) && parsedBefore > 0 ? parsedBefore : undefined;
  const { entries, hasMore } = getShellTranscriptEntries(id, { limit, beforeRowId });

  return NextResponse.json({
    entries,
    hasMore,
  });
}
