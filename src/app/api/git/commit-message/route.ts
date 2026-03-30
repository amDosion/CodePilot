import { NextRequest, NextResponse } from 'next/server';
import { describeGitTarget, gitGenerateCommitMessage, gitStatus, isGitServiceError, parseGitContextFromBody, readGitBoolean, resolveGitTarget } from '@/lib/git';
import type { ErrorResponse, GitCommitMessageResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const staged = readGitBoolean(body.staged);
    const target = await resolveGitTarget(parseGitContextFromBody(body));
    const status = await gitStatus(target);

    return NextResponse.json<GitCommitMessageResponse>({
      suggestion: status.is_repo
        ? await gitGenerateCommitMessage(target, { staged: body.staged === undefined ? true : staged })
        : {
          message: '',
          summary: 'Current directory is not a Git repository',
          files: [],
          staged: body.staged === undefined ? true : staged,
        },
      is_repo: status.is_repo,
      target: describeGitTarget(target),
    });
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to generate Git commit message' },
      { status: 500 },
    );
  }
}
