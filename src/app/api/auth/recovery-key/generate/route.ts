import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse } from '@/lib/auth/http';
import { generateRecoveryKeyForUser, requireSessionFromRequest } from '@/lib/auth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await requireSessionFromRequest(request);
    const result = generateRecoveryKeyForUser(session.user.id);

    return NextResponse.json(result);
  } catch (error) {
    return authErrorResponse(error, 'POST /api/auth/recovery-key/generate');
  }
}
