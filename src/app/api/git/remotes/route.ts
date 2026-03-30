import { NextRequest, NextResponse } from 'next/server';
import { describeGitTarget, gitAddRemote, gitRemotes, gitRemoveRemote, gitStatus, isGitServiceError, parseGitContextFromBody, parseGitContextFromSearchParams, readGitString, resolveGitTarget } from '@/lib/git';
import type { ErrorResponse, GitRemotesResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleGet(context: ReturnType<typeof parseGitContextFromBody>) {
  const target = await resolveGitTarget(context);
  const status = await gitStatus(target);
  return NextResponse.json<GitRemotesResponse>({
    remotes: status.is_repo ? await gitRemotes(target) : [],
    is_repo: status.is_repo,
    target: describeGitTarget(target),
  });
}

export async function GET(request: NextRequest) {
  try {
    return await handleGet(parseGitContextFromSearchParams(request.nextUrl.searchParams));
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to read Git remotes' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = readGitString(body.action);
    const target = await resolveGitTarget(parseGitContextFromBody(body));
    const status = await gitStatus(target);

    if (!status.is_repo) {
      return NextResponse.json<GitRemotesResponse>({
        remotes: [],
        is_repo: false,
        target: describeGitTarget(target),
      });
    }

    if (action === 'add') {
      const name = readGitString(body.name);
      const url = readGitString(body.url);
      if (!name || !url) {
        return NextResponse.json<ErrorResponse>({ error: 'name and url are required for add' }, { status: 400 });
      }
      await gitAddRemote(target, name, url);
    } else if (action === 'remove') {
      const name = readGitString(body.name);
      if (!name) {
        return NextResponse.json<ErrorResponse>({ error: 'name is required for remove' }, { status: 400 });
      }
      await gitRemoveRemote(target, name);
    } else {
      return NextResponse.json<ErrorResponse>({ error: 'action must be one of: add, remove' }, { status: 400 });
    }

    return NextResponse.json<GitRemotesResponse>({
      remotes: await gitRemotes(target),
      is_repo: true,
      target: describeGitTarget(target),
    });
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to update Git remotes' },
      { status: 500 },
    );
  }
}
