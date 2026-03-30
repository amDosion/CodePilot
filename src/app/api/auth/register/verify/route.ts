import { NextRequest, NextResponse } from 'next/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { AUTH_COOKIE_NAME } from '@/lib/auth/constants';
import { authErrorResponse, isRecord } from '@/lib/auth/http';
import { generateRecoveryKeyForUser, verifyRegistrationForRequest } from '@/lib/auth/service';
import { getSessionCookieOptions } from '@/lib/auth/token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || typeof body.token !== 'string' || !isRecord(body.response)) {
      return NextResponse.json(
        { error: 'token and response are required', code: 'INVALID_REQUEST' },
        { status: 400 },
      );
    }

    const result = await verifyRegistrationForRequest(request, {
      token: body.token,
      response: body.response as unknown as RegistrationResponseJSON,
    });

    // Auto-generate a recovery key for the newly registered user
    let recoveryKeyFile = null;
    try {
      const recovery = generateRecoveryKeyForUser(result.user.id);
      recoveryKeyFile = recovery.keyFile;
    } catch {
      // Non-fatal: user can generate a recovery key later
    }

    const response = NextResponse.json({
      verified: true,
      user: result.user,
      recoveryKeyFile,
    });
    response.cookies.set(
      AUTH_COOKIE_NAME,
      result.session.token,
      getSessionCookieOptions(result.session.maxAgeSeconds),
    );

    return response;
  } catch (error) {
    return authErrorResponse(error, 'POST /api/auth/register/verify');
  }
}
