import { NextRequest, NextResponse } from 'next/server';
import { isGitHubDeviceFlowConfigured, pollGitHubDeviceToken } from '@/lib/github-device-flow';
import { readGitString } from '@/lib/git';
import type { GitHubDevicePollResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const deviceCode = readGitString(body.device_code);

  if (!deviceCode) {
    return NextResponse.json<GitHubDevicePollResponse>(
      { status: 'error', error: 'device_code is required' },
      {
        status: 400,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  if (!isGitHubDeviceFlowConfigured()) {
    return NextResponse.json<GitHubDevicePollResponse>(
      { status: 'error', error: 'GitHub Device Flow is not configured' },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  try {
    const result = await pollGitHubDeviceToken(deviceCode);
    const status = result.status === 'approved'
      ? 200
      : result.status === 'pending' || result.status === 'slow_down'
        ? 202
        : result.status === 'expired'
          ? 410
          : result.status === 'denied'
            ? 400
            : 502;

    return NextResponse.json<GitHubDevicePollResponse>(result, {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json<GitHubDevicePollResponse>(
      {
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to poll GitHub Device Flow',
      },
      {
        status: 502,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }
}
