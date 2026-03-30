import { NextRequest, NextResponse } from 'next/server';
import { describeGitTarget, gitClone, isGitServiceError, parseGitContextFromBody, readGitString, resolveGitTarget } from '@/lib/git';
import type { ErrorResponse, GitCloneResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const repositoryUrl = readGitString(body.repository_url);
    const destination = readGitString(body.destination);

    if (!repositoryUrl || !destination) {
      return NextResponse.json<ErrorResponse>({ error: 'repository_url and destination are required' }, { status: 400 });
    }

    const target = await resolveGitTarget(parseGitContextFromBody(body));
    const resolvedDestination = await gitClone(target, repositoryUrl, destination);

    return NextResponse.json<GitCloneResponse>({
      success: true,
      is_repo: true,
      target: describeGitTarget(target),
      destination: resolvedDestination,
    });
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to clone Git repository' },
      { status: 500 },
    );
  }
}
