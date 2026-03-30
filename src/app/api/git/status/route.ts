import { NextRequest, NextResponse } from 'next/server';
import { describeGitTarget, gitStatus, isGitServiceError, parseGitContextFromBody, parseGitContextFromSearchParams, resolveGitTarget } from '@/lib/git';
import type { ErrorResponse, GitStatusResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleRequest(context: ReturnType<typeof parseGitContextFromBody>) {
  const target = await resolveGitTarget(context);
  const status = await gitStatus(target);
  return NextResponse.json<GitStatusResponse>({
    status,
    target: describeGitTarget(target),
  });
}

export async function GET(request: NextRequest) {
  try {
    return await handleRequest(parseGitContextFromSearchParams(request.nextUrl.searchParams));
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to read Git status' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    return await handleRequest(parseGitContextFromBody(body));
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to read Git status' },
      { status: 500 },
    );
  }
}
