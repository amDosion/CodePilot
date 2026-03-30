import { NextRequest, NextResponse } from 'next/server';
import { createAuthenticationOptionsForRequest } from '@/lib/auth/service';
import { authErrorResponse } from '@/lib/auth/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const data = await createAuthenticationOptionsForRequest(request);
    return NextResponse.json(data);
  } catch (error) {
    return authErrorResponse(error, 'POST /api/auth/login/options');
  }
}
