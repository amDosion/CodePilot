import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { NextRequest } from 'next/server';
import {
  AUTH_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  getExpectedOrigins,
  getRpID,
  getRpName,
} from '@/lib/auth/constants';
import crypto from 'crypto';
import {
  createBootstrapUser,
  createChallenge,
  createRecoveryKey,
  createSession,
  cleanupExpiredAuthRecords,
  countUsers,
  ensureAuthTables,
  getActiveRecoveryKeyByHash,
  getFirstUser,
  getActiveSessionById,
  getChallengeForVerification,
  getPasskeyByCredentialId,
  getUserById,
  listAllPasskeys,
  listPasskeysForUser,
  markChallengeUsed,
  parseTransports,
  persistInitialPasskey,
  revokeAllRecoveryKeysForUser,
  revokeSessionById,
  updatePasskeyAfterAuthentication,
  updateRecoveryKeyLastUsed,
  type AuthSession,
  type AuthUser,
} from '@/lib/auth/store';
import {
  createSignedSessionToken,
  verifySignedSessionToken,
  type SessionTokenClaims,
} from '@/lib/auth/token';

export class AuthServiceError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface PublicAuthUser {
  id: string;
  username: string;
  displayName: string;
}

interface SessionContext {
  user: AuthUser;
  session: AuthSession;
  claims: SessionTokenClaims;
}

interface RegistrationOptionsResult {
  options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
  token: string;
  user: PublicAuthUser;
  bootstrap: boolean;
}

interface LoginOptionsResult {
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
  token: string;
}

interface SessionIssueResult {
  token: string;
  maxAgeSeconds: number;
}

function toPublicUser(user: AuthUser): PublicAuthUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
  };
}

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const [first] = forwarded.split(',');
    return first?.trim() || '';
  }

  return request.headers.get('x-real-ip') || '';
}

function getDisplayName(input?: string): string {
  const normalized = (input || '').trim();
  return normalized || 'Owner';
}

function normalizeTransports(input: unknown): AuthenticatorTransportFuture[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.filter((item): item is AuthenticatorTransportFuture => typeof item === 'string');
}

async function issueSessionForUser(request: NextRequest, userId: string): Promise<SessionIssueResult> {
  const session = createSession({
    userId,
    ttlSeconds: SESSION_TTL_SECONDS,
    userAgent: request.headers.get('user-agent') || '',
    ipAddress: getClientIp(request),
  });

  const signed = await createSignedSessionToken({
    sessionId: session.id,
    userId,
    maxAgeSeconds: SESSION_TTL_SECONDS,
  });

  return {
    token: signed.token,
    maxAgeSeconds: SESSION_TTL_SECONDS,
  };
}

function requireChallenge(token: string, type: 'registration' | 'authentication') {
  const challenge = getChallengeForVerification(token, type);
  if (!challenge) {
    throw new AuthServiceError(400, 'INVALID_OR_EXPIRED_CHALLENGE', 'Challenge is invalid or expired');
  }
  return challenge;
}

function assertInitialSetupOpen(): void {
  if (listAllPasskeys().length > 0) {
    throw new AuthServiceError(
      403,
      'SETUP_ALREADY_COMPLETED',
      'Initial passkey setup has already been completed for this installation',
    );
  }
}

export async function createRegistrationOptionsForRequest(
  request: NextRequest,
  input?: { displayName?: string; username?: string },
): Promise<RegistrationOptionsResult> {
  ensureAuthTables();
  cleanupExpiredAuthRecords();
  assertInitialSetupOpen();

  const existingUserCount = countUsers();
  let user: AuthUser;
  if (existingUserCount === 0) {
    user = createBootstrapUser(getDisplayName(input?.displayName), input?.username);
  } else {
    const bootstrapUser = getFirstUser();
    if (!bootstrapUser) {
      user = createBootstrapUser(getDisplayName(input?.displayName), input?.username);
    } else {
      user = bootstrapUser;
    }
  }

  const existingCredentials = listPasskeysForUser(user.id).map((credential) => ({
    id: credential.credential_id,
    transports: parseTransports(credential.transports),
  }));

  const options = await generateRegistrationOptions({
    rpName: getRpName(),
    rpID: getRpID(request.nextUrl.hostname),
    userName: user.username,
    userDisplayName: user.display_name,
    userID: isoBase64URL.toBuffer(user.webauthn_user_id),
    attestationType: 'none',
    excludeCredentials: existingCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  const challenge = createChallenge({
    type: 'registration',
    challenge: options.challenge,
    userId: user.id,
  });

  return {
    options,
    token: challenge.id,
    user: toPublicUser(user),
    bootstrap: true,
  };
}

export async function verifyRegistrationForRequest(
  request: NextRequest,
  input: { token: string; response: RegistrationResponseJSON },
): Promise<{ user: PublicAuthUser; session: SessionIssueResult }> {
  ensureAuthTables();
  cleanupExpiredAuthRecords();

  const challenge = requireChallenge(input.token, 'registration');
  if (!challenge.user_id) {
    throw new AuthServiceError(400, 'CHALLENGE_MISSING_USER', 'Registration challenge is invalid');
  }

  const user = getUserById(challenge.user_id);
  if (!user) {
    throw new AuthServiceError(404, 'USER_NOT_FOUND', 'User not found for registration challenge');
  }

  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: getExpectedOrigins(request.nextUrl.origin),
    expectedRPID: getRpID(request.nextUrl.hostname),
    requireUserVerification: true,
  });

  if (!verification.verified) {
    throw new AuthServiceError(401, 'REGISTRATION_NOT_VERIFIED', 'Passkey registration verification failed');
  }

  const registrationInfo = verification.registrationInfo;
  const transports = normalizeTransports(input.response.response.transports ?? registrationInfo.credential.transports);

  const persisted = persistInitialPasskey({
    credentialId: registrationInfo.credential.id,
    userId: user.id,
    publicKey: isoBase64URL.fromBuffer(registrationInfo.credential.publicKey),
    counter: registrationInfo.credential.counter,
    deviceType: registrationInfo.credentialDeviceType,
    backedUp: registrationInfo.credentialBackedUp,
    transports,
  });
  if (!persisted) {
    throw new AuthServiceError(
      403,
      'SETUP_ALREADY_COMPLETED',
      'Initial passkey setup has already been completed for this installation',
    );
  }

  markChallengeUsed(challenge.id);
  const session = await issueSessionForUser(request, user.id);

  return {
    user: toPublicUser(user),
    session,
  };
}

export async function createAuthenticationOptionsForRequest(request: NextRequest): Promise<LoginOptionsResult> {
  ensureAuthTables();
  cleanupExpiredAuthRecords();

  if (countUsers() === 0) {
    throw new AuthServiceError(400, 'NO_AUTH_USER', 'No passkey user exists yet. Register first.');
  }

  const registeredCredentials = listAllPasskeys().map((credential) => ({
    id: credential.credential_id,
    transports: parseTransports(credential.transports),
  }));

  const options = await generateAuthenticationOptions({
    rpID: getRpID(request.nextUrl.hostname),
    userVerification: 'preferred',
    allowCredentials: registeredCredentials.length > 0 ? registeredCredentials : undefined,
  });

  const challenge = createChallenge({
    type: 'authentication',
    challenge: options.challenge,
  });

  return {
    options,
    token: challenge.id,
  };
}

export async function verifyAuthenticationForRequest(
  request: NextRequest,
  input: { token: string; response: AuthenticationResponseJSON },
): Promise<{ user: PublicAuthUser; session: SessionIssueResult }> {
  ensureAuthTables();
  cleanupExpiredAuthRecords();

  const challenge = requireChallenge(input.token, 'authentication');

  const existingCredential = getPasskeyByCredentialId(input.response.id);
  if (!existingCredential) {
    throw new AuthServiceError(401, 'UNKNOWN_CREDENTIAL', 'Passkey is not registered for this application');
  }

  const user = getUserById(existingCredential.user_id);
  if (!user) {
    throw new AuthServiceError(404, 'USER_NOT_FOUND', 'User not found for passkey');
  }

  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: getExpectedOrigins(request.nextUrl.origin),
    expectedRPID: getRpID(request.nextUrl.hostname),
    credential: {
      id: existingCredential.credential_id,
      publicKey: isoBase64URL.toBuffer(existingCredential.public_key),
      counter: existingCredential.counter,
      transports: parseTransports(existingCredential.transports),
    },
    requireUserVerification: true,
  });

  if (!verification.verified) {
    throw new AuthServiceError(401, 'AUTHENTICATION_NOT_VERIFIED', 'Passkey authentication verification failed');
  }

  updatePasskeyAfterAuthentication({
    credentialId: existingCredential.credential_id,
    newCounter: verification.authenticationInfo.newCounter,
    deviceType: verification.authenticationInfo.credentialDeviceType,
    backedUp: verification.authenticationInfo.credentialBackedUp,
  });

  markChallengeUsed(challenge.id);

  const session = await issueSessionForUser(request, user.id);

  return {
    user: toPublicUser(user),
    session,
  };
}

export async function getSessionFromRequest(request: NextRequest): Promise<SessionContext | null> {
  ensureAuthTables();
  cleanupExpiredAuthRecords();

  const cookie = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!cookie) {
    return null;
  }

  const claims = await verifySignedSessionToken(cookie);
  if (!claims) {
    return null;
  }

  const session = getActiveSessionById(claims.sid);
  if (!session || session.user_id !== claims.uid) {
    return null;
  }

  const user = getUserById(claims.uid);
  if (!user) {
    return null;
  }

  return { user, session, claims };
}

export async function requireSessionFromRequest(request: NextRequest): Promise<SessionContext> {
  const context = await getSessionFromRequest(request);
  if (!context) {
    throw new AuthServiceError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return context;
}

export async function logoutFromRequest(request: NextRequest): Promise<void> {
  ensureAuthTables();

  const cookie = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!cookie) {
    return;
  }

  const claims = await verifySignedSessionToken(cookie);
  if (!claims) {
    return;
  }

  revokeSessionById(claims.sid);
}

// ── Recovery Key ──────────────────────────────────────────────────

export interface RecoveryKeyFilePayload {
  version: 1;
  type: 'codepilot-recovery-key';
  userId: string;
  keyId: string;
  secret: string;
  createdAt: string;
  label: string;
}

export function generateRecoveryKeyForUser(
  userId: string,
  label?: string,
): { keyFile: RecoveryKeyFilePayload } {
  ensureAuthTables();
  const rawSecret = crypto.randomBytes(32).toString('base64url');
  const keyHash = crypto.createHash('sha256').update(rawSecret).digest('hex');
  const row = createRecoveryKey(userId, keyHash, label);

  return {
    keyFile: {
      version: 1,
      type: 'codepilot-recovery-key',
      userId,
      keyId: row.id,
      secret: rawSecret,
      createdAt: row.created_at,
      label: row.label,
    },
  };
}

export async function verifyRecoveryKeyForRequest(
  request: NextRequest,
  keyFile: RecoveryKeyFilePayload,
): Promise<{ user: PublicAuthUser; session: SessionIssueResult }> {
  ensureAuthTables();
  cleanupExpiredAuthRecords();

  if (keyFile.version !== 1 || keyFile.type !== 'codepilot-recovery-key' || !keyFile.secret) {
    throw new AuthServiceError(400, 'INVALID_RECOVERY_KEY', 'Invalid recovery key file format');
  }

  // Recovery key login requires initial passkey setup to be completed
  if (listAllPasskeys().length === 0) {
    throw new AuthServiceError(403, 'SETUP_NOT_COMPLETED', 'Initial passkey setup must be completed before using recovery key login');
  }

  const keyHash = crypto.createHash('sha256').update(keyFile.secret).digest('hex');
  const recoveryKey = getActiveRecoveryKeyByHash(keyHash);
  if (!recoveryKey) {
    throw new AuthServiceError(401, 'INVALID_RECOVERY_KEY', 'Recovery key is invalid or has been revoked');
  }

  if (recoveryKey.user_id !== keyFile.userId) {
    throw new AuthServiceError(401, 'INVALID_RECOVERY_KEY', 'Recovery key does not match the specified user');
  }

  const user = getUserById(recoveryKey.user_id);
  if (!user) {
    throw new AuthServiceError(404, 'USER_NOT_FOUND', 'User not found for recovery key');
  }

  updateRecoveryKeyLastUsed(recoveryKey.id);
  const session = await issueSessionForUser(request, user.id);

  return { user: toPublicUser(user), session };
}

export function revokeAndRegenerateRecoveryKey(
  userId: string,
  label?: string,
): { keyFile: RecoveryKeyFilePayload } {
  ensureAuthTables();
  revokeAllRecoveryKeysForUser(userId);
  return generateRecoveryKeyForUser(userId, label);
}
