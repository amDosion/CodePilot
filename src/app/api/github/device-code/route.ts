import { NextResponse } from 'next/server';
import {
  getGitHubScope,
  isGitHubDeviceFlowConfigured,
  requestGitHubDeviceCode,
} from '@/lib/github-device-flow';
import type { GitHubDeviceCodeResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function createStatusBody(error?: string): GitHubDeviceCodeResponse {
  const configured = isGitHubDeviceFlowConfigured();
  return {
    enabled: configured,
    configured,
    desktop_only: true,
    scope: getGitHubScope(),
    error,
  };
}

export async function GET() {
  const body = createStatusBody();
  return NextResponse.json(body, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST() {
  if (!isGitHubDeviceFlowConfigured()) {
    return NextResponse.json(
      createStatusBody('GitHub Device Flow is not configured'),
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  try {
    const flow = await requestGitHubDeviceCode();
    return NextResponse.json<GitHubDeviceCodeResponse>(
      {
        ...createStatusBody(),
        flow,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  } catch (error) {
    return NextResponse.json<GitHubDeviceCodeResponse>(
      createStatusBody(error instanceof Error ? error.message : 'Failed to start GitHub Device Flow'),
      {
        status: 502,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }
}
