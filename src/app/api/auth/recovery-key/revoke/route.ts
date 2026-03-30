import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, isRecord } from '@/lib/auth/http';
import { requireSessionFromRequest } from '@/lib/auth/service';
import { revokeAllRecoveryKeysForUser, revokeRecoveryKey } from '@/lib/auth/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await requireSessionFromRequest(request);
    const body = await request.json().catch(() => null);

    if (isRecord(body) && typeof body.keyId === 'string' && body.keyId) {
      revokeRecoveryKey(body.keyId);
    } else {
      revokeAllRecoveryKeysForUser(session.user.id);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return authErrorResponse(error, 'POST /api/auth/recovery-key/revoke');
  }
}
