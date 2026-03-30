import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse } from '@/lib/auth/http';
import { getSessionFromRequest } from '@/lib/auth/service';
import { ensureAuthTables, getFirstUser, hasActiveRecoveryKey, listAllPasskeys } from '@/lib/auth/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    ensureAuthTables();
    const session = await getSessionFromRequest(request);
    const hasPasskey = listAllPasskeys().length > 0;
    const requiresSetup = !hasPasskey;

    if (!session) {
      // Check if any user has a recovery key (for showing the import option)
      const firstUser = getFirstUser();
      const hasRecoveryKey = firstUser ? hasActiveRecoveryKey(firstUser.id) : false;

      return NextResponse.json({
        authenticated: false,
        hasPasskey,
        hasRecoveryKey,
        requiresSetup,
      });
    }

    return NextResponse.json({
      authenticated: true,
      hasPasskey,
      hasRecoveryKey: hasActiveRecoveryKey(session.user.id),
      requiresSetup: false,
      user: {
        id: session.user.id,
        username: session.user.username,
        displayName: session.user.display_name,
      },
      expiresAt: session.session.expires_at,
    });
  } catch (error) {
    return authErrorResponse(error, 'GET /api/auth/status');
  }
}
