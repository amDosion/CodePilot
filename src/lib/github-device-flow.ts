import type {
  GitHubAuthSession,
  GitHubDeviceCode,
  GitHubUserProfile,
} from '@/types';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const DEFAULT_GITHUB_SCOPE = 'repo';

type GitHubDevicePollStatus = 'pending' | 'slow_down' | 'approved' | 'denied' | 'expired' | 'error';

interface GitHubDeviceCodePayload {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface GitHubAccessTokenPayload {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

export interface GitHubDevicePollResult {
  status: GitHubDevicePollStatus;
  interval?: number;
  session?: GitHubAuthSession;
  error?: string;
}

function githubHeaders(extra?: HeadersInit): HeadersInit {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'CodePilot',
    ...extra,
  };
}

async function readGitHubJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof (data as { error_description?: unknown }).error_description === 'string'
      ? (data as { error_description: string }).error_description
      : `GitHub request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

export function getGitHubClientId(): string {
  return (process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_CLIENT_ID || '').trim();
}

export function getGitHubScope(): string {
  return (process.env.GITHUB_OAUTH_SCOPE || process.env.GITHUB_OAUTH_SCOPES || DEFAULT_GITHUB_SCOPE).trim() || DEFAULT_GITHUB_SCOPE;
}

export function isGitHubDeviceFlowConfigured(): boolean {
  return Boolean(getGitHubClientId());
}

export async function requestGitHubDeviceCode(): Promise<GitHubDeviceCode> {
  const clientId = getGitHubClientId();
  if (!clientId) {
    throw new Error('GitHub Device Flow is not configured');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    scope: getGitHubScope(),
  });

  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: githubHeaders(),
    body,
    cache: 'no-store',
  });

  const data = await readGitHubJson<GitHubDeviceCodePayload>(response);
  if (!data.device_code || !data.user_code || !data.verification_uri || !data.expires_in || !data.interval) {
    throw new Error(data.error_description || data.error || 'GitHub did not return a complete device code payload');
  }

  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: data.expires_in,
    interval: data.interval,
  };
}

export async function fetchGitHubViewer(accessToken: string): Promise<GitHubUserProfile | null> {
  if (!accessToken) {
    return null;
  }

  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'CodePilot',
    },
    cache: 'no-store',
  });

  const data = await readGitHubJson<Record<string, unknown>>(response);
  const id = typeof data.id === 'number' ? data.id : Number(data.id || 0);
  const login = typeof data.login === 'string' ? data.login : '';
  if (!id || !login) {
    return null;
  }

  return {
    id,
    login,
    avatar_url: typeof data.avatar_url === 'string' ? data.avatar_url : undefined,
    html_url: typeof data.html_url === 'string' ? data.html_url : undefined,
  };
}

export async function pollGitHubDeviceToken(deviceCode: string): Promise<GitHubDevicePollResult> {
  const clientId = getGitHubClientId();
  if (!clientId) {
    return {
      status: 'error',
      error: 'GitHub Device Flow is not configured',
    };
  }

  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: githubHeaders(),
    body,
    cache: 'no-store',
  });

  const data = await readGitHubJson<GitHubAccessTokenPayload>(response);
  if (data.access_token) {
    const session: GitHubAuthSession = {
      access_token: data.access_token,
      token_type: data.token_type || 'bearer',
      scope: data.scope || getGitHubScope(),
      acquired_at: new Date().toISOString(),
      user: await fetchGitHubViewer(data.access_token),
    };
    return {
      status: 'approved',
      session,
    };
  }

  const interval = typeof data.interval === 'number' ? data.interval : undefined;
  switch (data.error) {
    case 'authorization_pending':
      return { status: 'pending', interval, error: data.error_description || 'Authorization pending' };
    case 'slow_down':
      return { status: 'slow_down', interval, error: data.error_description || 'Polling too quickly' };
    case 'access_denied':
      return { status: 'denied', error: data.error_description || 'Access denied by user' };
    case 'expired_token':
      return { status: 'expired', error: data.error_description || 'Device code expired' };
    default:
      return {
        status: 'error',
        interval,
        error: data.error_description || data.error || 'GitHub token polling failed',
      };
  }
}
