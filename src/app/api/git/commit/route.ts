import { NextRequest, NextResponse } from 'next/server';
import { describeGitTarget, gitCommit, gitStatus, isGitServiceError, parseGitContextFromBody, readGitString, resolveGitTarget } from '@/lib/git';
import type { ErrorResponse, GitCommitResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const message = readGitString(body.message);
    if (!message) {
      return NextResponse.json<ErrorResponse>({ error: 'message is required' }, { status: 400 });
    }

    const target = await resolveGitTarget(parseGitContextFromBody(body));
    const currentStatus = await gitStatus(target);

    if (!currentStatus.is_repo) {
      return NextResponse.json<GitCommitResponse>({
        success: false,
        is_repo: false,
        target: describeGitTarget(target),
        status: currentStatus,
        error: 'Current directory is not a Git repository',
      });
    }

    const commit = await gitCommit(target, message);
    const status = await gitStatus(target);
    return NextResponse.json<GitCommitResponse>({
      success: true,
      is_repo: true,
      target: describeGitTarget(target),
      commit,
      status,
    });
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to create Git commit' },
      { status: 500 },
    );
  }
}
