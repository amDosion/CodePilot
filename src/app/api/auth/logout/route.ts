import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME } from '@/lib/auth/constants';
import { authErrorResponse } from '@/lib/auth/http';
import { logoutFromRequest } from '@/lib/auth/service';
import { getClearSessionCookieOptions } from '@/lib/auth/token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    await logoutFromRequest(request);

    const response = NextResponse.json({ ok: true });
    response.cookies.set(AUTH_COOKIE_NAME, '', getClearSessionCookieOptions());
    return response;
  } catch (error) {
    return authErrorResponse(error, 'POST /api/auth/logout');
  }
}
