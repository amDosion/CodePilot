import { NextRequest, NextResponse } from 'next/server';
import { describeGitTarget, gitDiff, gitStatus, isGitServiceError, parseGitContextFromBody, parseGitContextFromSearchParams, readGitBoolean, readGitString, resolveGitTarget } from '@/lib/git';
import type { ErrorResponse, GitDiffResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleRequest(
  context: ReturnType<typeof parseGitContextFromBody>,
  options: { staged: boolean; filePath: string; sha: string },
) {
  const target = await resolveGitTarget(context);
  const status = await gitStatus(target);

  return NextResponse.json<GitDiffResponse>({
    diff: status.is_repo
      ? await gitDiff(target, {
        staged: options.staged,
        filePath: options.filePath || undefined,
        sha: options.sha || undefined,
      })
      : '',
    is_repo: status.is_repo,
    target: describeGitTarget(target),
  });
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    return await handleRequest(parseGitContextFromSearchParams(searchParams), {
      staged: readGitBoolean(searchParams.get('staged')),
      filePath: readGitString(searchParams.get('file')),
      sha: readGitString(searchParams.get('sha')),
    });
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to read Git diff' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    return await handleRequest(parseGitContextFromBody(body), {
      staged: readGitBoolean(body.staged),
      filePath: readGitString(body.file),
      sha: readGitString(body.sha),
    });
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to read Git diff' },
      { status: 500 },
    );
  }
}
