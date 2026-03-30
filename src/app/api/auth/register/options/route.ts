import { NextRequest, NextResponse } from 'next/server';
import { createRegistrationOptionsForRequest } from '@/lib/auth/service';
import { authErrorResponse, isRecord } from '@/lib/auth/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const username = isRecord(body) && typeof body.username === 'string'
      ? body.username
      : undefined;
    const displayName = isRecord(body) && typeof body.displayName === 'string'
      ? body.displayName
      : undefined;

    const data = await createRegistrationOptionsForRequest(request, { username, displayName });
    return NextResponse.json(data);
  } catch (error) {
    return authErrorResponse(error, 'POST /api/auth/register/options');
  }
}
