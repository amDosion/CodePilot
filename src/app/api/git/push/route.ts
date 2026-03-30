import { NextRequest, NextResponse } from 'next/server';
import { describeGitTarget, gitPush, gitStatus, isGitServiceError, parseGitContextFromBody, readGitString, resolveGitTarget } from '@/lib/git';
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

    await gitPush(target, readGitString(body.remote), readGitString(body.branch));
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
      { error: error instanceof Error ? error.message : 'Failed to push Git changes' },
      { status: 500 },
    );
  }
}
