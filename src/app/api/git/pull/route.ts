import { NextRequest, NextResponse } from 'next/server';
import { describeGitTarget, gitPull, gitStatus, isGitServiceError, parseGitContextFromBody, readGitString, resolveGitTarget } from '@/lib/git';
import type { ErrorResponse, GitStatusActionResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const target = await resolveGitTarget(parseGitContextFromBody(body));
    const currentStatus = await gitStatus(target);

    if (!currentStatus.is_repo) {
      return NextResponse.json<GitStatusActionResponse>({
        success: false,
        is_repo: false,
        target: describeGitTarget(target),
        status: currentStatus,
        error: 'Current directory is not a Git repository',
      });
    }

    await gitPull(target, readGitString(body.remote), readGitString(body.branch));
    const status = await gitStatus(target);
    return NextResponse.json<GitStatusActionResponse>({
      success: true,
      is_repo: true,
      target: describeGitTarget(target),
      status,
    });
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to pull Git changes' },
      { status: 500 },
    );
  }
}
