import { NextRequest, NextResponse } from 'next/server';
import { describeGitTarget, gitInit, gitStatus, isGitServiceError, parseGitContextFromBody, resolveGitTarget } from '@/lib/git';
import type { ErrorResponse, GitStatusActionResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const target = await resolveGitTarget(parseGitContextFromBody(body));
    await gitInit(target);
    const status = await gitStatus(target);

    return NextResponse.json<GitStatusActionResponse>({
      success: true,
      is_repo: status.is_repo,
      target: describeGitTarget(target),
      status,
    });
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to initialize Git repository' },
      { status: 500 },
    );
  }
}
