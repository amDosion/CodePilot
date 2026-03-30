import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME } from '@/lib/auth/constants';
import { authErrorResponse, isRecord } from '@/lib/auth/http';
import { verifyRecoveryKeyForRequest, type RecoveryKeyFilePayload } from '@/lib/auth/service';
import { getSessionCookieOptions } from '@/lib/auth/token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || !isRecord(body.keyFile)) {
      return NextResponse.json(
        { error: 'keyFile is required', code: 'INVALID_REQUEST' },
        { status: 400 },
      );
    }

    const keyFile = body.keyFile as unknown as RecoveryKeyFilePayload;
    const result = await verifyRecoveryKeyForRequest(request, keyFile);

    const response = NextResponse.json({ verified: true, user: result.user });
    response.cookies.set(
      AUTH_COOKIE_NAME,
      result.session.token,
      getSessionCookieOptions(result.session.maxAgeSeconds),
    );

    return response;
  } catch (error) {
    return authErrorResponse(error, 'POST /api/auth/recovery-key/verify');
  }
}
