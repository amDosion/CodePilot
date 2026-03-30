import { NextRequest, NextResponse } from 'next/server';
import { describeGitTarget, gitLog, gitStatus, isGitServiceError, parseGitContextFromBody, parseGitContextFromSearchParams, readGitNumber, resolveGitTarget } from '@/lib/git';
import type { ErrorResponse, GitLogResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleRequest(context: ReturnType<typeof parseGitContextFromBody>, maxCount: number) {
  const target = await resolveGitTarget(context);
  const status = await gitStatus(target);

  return NextResponse.json<GitLogResponse>({
    entries: status.is_repo ? await gitLog(target, maxCount) : [],
    is_repo: status.is_repo,
    target: describeGitTarget(target),
  });
}

export async function GET(request: NextRequest) {
  try {
    const context = parseGitContextFromSearchParams(request.nextUrl.searchParams);
    const maxCount = readGitNumber(request.nextUrl.searchParams.get('max_count'), 50, { min: 1, max: 200 });
    return await handleRequest(context, maxCount);
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to read Git log' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const maxCount = readGitNumber(body.max_count, 50, { min: 1, max: 200 });
    return await handleRequest(parseGitContextFromBody(body), maxCount);
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to read Git log' },
      { status: 500 },
    );
  }
}
