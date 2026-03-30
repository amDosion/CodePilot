import { NextRequest, NextResponse } from 'next/server';
import { describeGitTarget, gitBranches, gitCheckout, gitCreateBranch, gitDeleteBranch, gitStatus, isGitServiceError, parseGitContextFromBody, parseGitContextFromSearchParams, readGitBoolean, readGitString, resolveGitTarget } from '@/lib/git';
import type { ErrorResponse, GitBranchesResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleGet(context: ReturnType<typeof parseGitContextFromBody>) {
  const target = await resolveGitTarget(context);
  const status = await gitStatus(target);
  return NextResponse.json<GitBranchesResponse>({
    branches: status.is_repo ? await gitBranches(target) : { current: '', local: [], remote: [] },
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
      { error: error instanceof Error ? error.message : 'Failed to read Git branches' },
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
      return NextResponse.json<GitBranchesResponse>({
        branches: { current: '', local: [], remote: [] },
        is_repo: false,
        target: describeGitTarget(target),
      });
    }

    if (action === 'checkout') {
      const branch = readGitString(body.branch) || readGitString(body.name);
      if (!branch) {
        return NextResponse.json<ErrorResponse>({ error: 'branch is required for checkout' }, { status: 400 });
      }
      await gitCheckout(target, branch);
    } else if (action === 'create') {
      const name = readGitString(body.name) || readGitString(body.branch);
      if (!name) {
        return NextResponse.json<ErrorResponse>({ error: 'name is required for create' }, { status: 400 });
      }
      await gitCreateBranch(target, name, readGitString(body.start_point));
      if (readGitBoolean(body.checkout)) {
        await gitCheckout(target, name);
      }
    } else if (action === 'delete') {
      const name = readGitString(body.name) || readGitString(body.branch);
      if (!name) {
        return NextResponse.json<ErrorResponse>({ error: 'name is required for delete' }, { status: 400 });
      }
      await gitDeleteBranch(target, name, readGitBoolean(body.force));
    } else {
      return NextResponse.json<ErrorResponse>({ error: 'action must be one of: checkout, create, delete' }, { status: 400 });
    }

    return NextResponse.json<GitBranchesResponse>({
      branches: await gitBranches(target),
      is_repo: true,
      target: describeGitTarget(target),
    });
  } catch (error) {
    if (isGitServiceError(error)) {
      return NextResponse.json<ErrorResponse>({ error: error.message }, { status: error.status });
    }
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to update Git branches' },
      { status: 500 },
    );
  }
}
