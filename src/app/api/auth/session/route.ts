import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME } from '@/lib/auth/constants';
import { authErrorResponse } from '@/lib/auth/http';
import { getSessionFromRequest } from '@/lib/auth/service';
import { getClearSessionCookieOptions } from '@/lib/auth/token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionFromRequest(request);
    if (!session) {
      const response = NextResponse.json(
        { error: 'Authentication required', code: 'AUTH_REQUIRED' },
        { status: 401 },
      );
      response.cookies.set(AUTH_COOKIE_NAME, '', getClearSessionCookieOptions());
      return response;
    }

    return NextResponse.json({
      authenticated: true,
      user: {
        id: session.user.id,
        username: session.user.username,
        displayName: session.user.display_name,
      },
      expiresAt: session.session.expires_at,
    });
  } catch (error) {
    return authErrorResponse(error, 'GET /api/auth/session');
  }
}
