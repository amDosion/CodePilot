export const AUTH_COOKIE_NAME = 'codepilot_auth';

const DEV_SESSION_SECRET = 'codepilot-dev-session-secret-change-me';

export const SESSION_TTL_SECONDS = Number.parseInt(process.env.AUTH_SESSION_TTL_SECONDS || '', 10) || 60 * 60 * 24 * 14;
export const CHALLENGE_TTL_SECONDS = Number.parseInt(process.env.AUTH_CHALLENGE_TTL_SECONDS || '', 10) || 60 * 5;

export function getSessionSecret(): string {
  return process.env.AUTH_SESSION_SECRET || DEV_SESSION_SECRET;
}

export function getRpName(): string {
  return process.env.WEBAUTHN_RP_NAME || 'CodePilot';
}

export function getRpID(hostname?: string): string {
  const configured = process.env.WEBAUTHN_RP_ID?.trim();
  if (configured) return configured;

  if (hostname) {
    return hostname;
  }

  return 'localhost';
}

export function getExpectedOrigins(requestOrigin?: string): string[] {
  const configured = process.env.WEBAUTHN_ORIGIN
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) || [];

  if (requestOrigin && !configured.includes(requestOrigin)) {
    configured.push(requestOrigin);
  }

  if (configured.length > 0) {
    return configured;
  }

  return ['http://localhost:3000'];
}

export function isSecureCookie(): boolean {
  return process.env.NODE_ENV === 'production';
}
