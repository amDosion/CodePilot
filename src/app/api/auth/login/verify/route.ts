import { NextRequest, NextResponse } from 'next/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { AUTH_COOKIE_NAME } from '@/lib/auth/constants';
import { authErrorResponse, isRecord } from '@/lib/auth/http';
import { verifyAuthenticationForRequest } from '@/lib/auth/service';
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

    const result = await verifyAuthenticationForRequest(request, {
      token: body.token,
      response: body.response as unknown as AuthenticationResponseJSON,
    });

    const response = NextResponse.json({ verified: true, user: result.user });
    response.cookies.set(
      AUTH_COOKIE_NAME,
      result.session.token,
      getSessionCookieOptions(result.session.maxAgeSeconds),
    );

    return response;
  } catch (error) {
    return authErrorResponse(error, 'POST /api/auth/login/verify');
  }
}
