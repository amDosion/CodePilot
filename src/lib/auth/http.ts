import { NextResponse } from 'next/server';
import { AuthServiceError } from '@/lib/auth/service';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function authErrorResponse(error: unknown, context: string) {
  if (error instanceof AuthServiceError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
      },
      { status: error.status },
    );
  }

  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[${context}]`, message);

  return NextResponse.json(
    {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    },
    { status: 500 },
  );
}
