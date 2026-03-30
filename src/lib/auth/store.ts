import crypto from 'crypto';
import type { AuthenticatorTransportFuture, CredentialDeviceType } from '@simplewebauthn/server';
import { getDb } from '@/lib/db';
import { CHALLENGE_TTL_SECONDS, SESSION_TTL_SECONDS } from '@/lib/auth/constants';

export interface AuthUser {
  id: string;
  username: string;
  display_name: string;
  webauthn_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface AuthPasskey {
  credential_id: string;
  user_id: string;
  public_key: string;
  counter: number;
  device_type: CredentialDeviceType;
  backed_up: number;
  transports: string;
  created_at: string;
  last_used_at: string | null;
}

export interface AuthChallenge {
  id: string;
  challenge: string;
  type: 'registration' | 'authentication';
  user_id: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export interface AuthSession {
  id: string;
  user_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  user_agent: string;
  ip_address: string;
}

export interface AuthRecoveryKey {
  id: string;
  user_id: string;
  key_hash: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface PersistPasskeyInput {
  credentialId: string;
  userId: string;
  publicKey: string;
  counter: number;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  transports?: AuthenticatorTransportFuture[];
}

let tablesEnsured = false;

function nowIso(): string {
  return new Date().toISOString();
}

function futureIso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function normalizeUsername(input: string): string {
  const cleaned = input.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return cleaned || 'owner';
}

export function ensureAuthTables(): void {
  if (tablesEnsured) {
    return;
  }

  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      webauthn_user_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_passkeys (
      credential_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_type TEXT NOT NULL DEFAULT 'singleDevice',
      backed_up INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('registration', 'authentication')),
      user_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      user_agent TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_recovery_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_auth_passkeys_user_id ON auth_passkeys(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_challenges_expiry ON auth_challenges(expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_challenges_type_user ON auth_challenges(type, user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_recovery_keys_user_id ON auth_recovery_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_recovery_keys_hash ON auth_recovery_keys(key_hash);
  `);

  tablesEnsured = true;
}

export function cleanupExpiredAuthRecords(): void {
  ensureAuthTables();
  const db = getDb();
  const now = nowIso();

  db.prepare('DELETE FROM auth_challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)').run(now, now);
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(now);
}

export function countUsers(): number {
  ensureAuthTables();
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS count FROM auth_users').get() as { count: number };
  return row.count;
}

export function getFirstUser(): AuthUser | null {
  ensureAuthTables();
  const db = getDb();
  const row = db.prepare('SELECT * FROM auth_users ORDER BY created_at ASC LIMIT 1').get() as AuthUser | undefined;
  return row ?? null;
}

export function getUserById(userId: string): AuthUser | null {
  ensureAuthTables();
  const db = getDb();
  const row = db.prepare('SELECT * FROM auth_users WHERE id = ?').get(userId) as AuthUser | undefined;
  return row ?? null;
}

function usernameExists(username: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM auth_users WHERE username = ? LIMIT 1').get(username) as { 1: number } | undefined;
  return Boolean(row);
}

export function createBootstrapUser(displayName: string, preferredUsername?: string): AuthUser {
  ensureAuthTables();
  const db = getDb();

  const baseUsername = normalizeUsername(preferredUsername || displayName);
  let username = baseUsername;
  let suffix = 1;
  while (usernameExists(username)) {
    username = `${baseUsername}-${suffix}`;
    suffix += 1;
  }

  const id = makeId('usr');
  const now = nowIso();
  const webauthnUserId = crypto.randomBytes(32).toString('base64url');

  db.prepare(`
    INSERT INTO auth_users (id, username, display_name, webauthn_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, username, displayName.trim() || 'Owner', webauthnUserId, now, now);

  return {
    id,
    username,
    display_name: displayName.trim() || 'Owner',
    webauthn_user_id: webauthnUserId,
    created_at: now,
    updated_at: now,
  };
}

export function listPasskeysForUser(userId: string): AuthPasskey[] {
  ensureAuthTables();
  const db = getDb();
  return db
    .prepare('SELECT * FROM auth_passkeys WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId) as AuthPasskey[];
}

export function listAllPasskeys(): AuthPasskey[] {
  ensureAuthTables();
  const db = getDb();
  return db.prepare('SELECT * FROM auth_passkeys ORDER BY created_at ASC').all() as AuthPasskey[];
}

export function getPasskeyByCredentialId(credentialId: string): AuthPasskey | null {
  ensureAuthTables();
  const db = getDb();
  const row = db.prepare('SELECT * FROM auth_passkeys WHERE credential_id = ?').get(credentialId) as AuthPasskey | undefined;
  return row ?? null;
}

export function persistPasskey(input: PersistPasskeyInput): void {
  ensureAuthTables();
  const db = getDb();
  const now = nowIso();

  db.prepare(`
    INSERT INTO auth_passkeys
      (credential_id, user_id, public_key, counter, device_type, backed_up, transports, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(credential_id) DO UPDATE SET
      user_id = excluded.user_id,
      public_key = excluded.public_key,
      counter = excluded.counter,
      device_type = excluded.device_type,
      backed_up = excluded.backed_up,
      transports = excluded.transports,
      last_used_at = excluded.last_used_at
  `).run(
    input.credentialId,
    input.userId,
    input.publicKey,
    input.counter,
    input.deviceType,
    input.backedUp ? 1 : 0,
    JSON.stringify(input.transports ?? []),
    now,
    now,
  );
}

export function persistInitialPasskey(input: PersistPasskeyInput): boolean {
  ensureAuthTables();
  const db = getDb();
  const now = nowIso();
  const countPasskeys = db.prepare('SELECT COUNT(*) AS count FROM auth_passkeys');
  const insertPasskey = db.prepare(`
    INSERT INTO auth_passkeys
      (credential_id, user_id, public_key, counter, device_type, backed_up, transports, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    const row = countPasskeys.get() as { count: number };
    if (row.count > 0) {
      return false;
    }

    insertPasskey.run(
      input.credentialId,
      input.userId,
      input.publicKey,
      input.counter,
      input.deviceType,
      input.backedUp ? 1 : 0,
      JSON.stringify(input.transports ?? []),
      now,
      now,
    );

    return true;
  });

  return transaction();
}

export function updatePasskeyAfterAuthentication(input: {
  credentialId: string;
  newCounter: number;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
}): void {
  ensureAuthTables();
  const db = getDb();

  db.prepare(`
    UPDATE auth_passkeys
    SET counter = ?, device_type = ?, backed_up = ?, last_used_at = ?
    WHERE credential_id = ?
  `).run(
    input.newCounter,
    input.deviceType,
    input.backedUp ? 1 : 0,
    nowIso(),
    input.credentialId,
  );
}

export function createChallenge(input: {
  type: 'registration' | 'authentication';
  challenge: string;
  userId?: string;
  ttlSeconds?: number;
}): AuthChallenge {
  ensureAuthTables();
  cleanupExpiredAuthRecords();

  const db = getDb();
  const id = makeId('chl');
  const createdAt = nowIso();
  const expiresAt = futureIso(input.ttlSeconds ?? CHALLENGE_TTL_SECONDS);

  db.prepare(`
    INSERT INTO auth_challenges (id, challenge, type, user_id, created_at, expires_at, used_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(id, input.challenge, input.type, input.userId ?? null, createdAt, expiresAt);

  return {
    id,
    challenge: input.challenge,
    type: input.type,
    user_id: input.userId ?? null,
    created_at: createdAt,
    expires_at: expiresAt,
    used_at: null,
  };
}

export function getChallengeForVerification(id: string, type: 'registration' | 'authentication'): AuthChallenge | null {
  ensureAuthTables();
  cleanupExpiredAuthRecords();

  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM auth_challenges WHERE id = ? AND type = ? AND used_at IS NULL LIMIT 1',
  ).get(id, type) as AuthChallenge | undefined;

  if (!row) {
    return null;
  }

  if (Date.parse(row.expires_at) <= Date.now()) {
    return null;
  }

  return row;
}

export function markChallengeUsed(id: string): void {
  ensureAuthTables();
  const db = getDb();
  db.prepare('UPDATE auth_challenges SET used_at = ? WHERE id = ?').run(nowIso(), id);
}

export function createSession(input: {
  userId: string;
  userAgent?: string;
  ipAddress?: string;
  ttlSeconds?: number;
}): AuthSession {
  ensureAuthTables();
  cleanupExpiredAuthRecords();

  const db = getDb();
  const id = makeId('ses');
  const issuedAt = nowIso();
  const expiresAt = futureIso(input.ttlSeconds ?? SESSION_TTL_SECONDS);

  db.prepare(`
    INSERT INTO auth_sessions (id, user_id, issued_at, expires_at, revoked_at, user_agent, ip_address)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
  `).run(
    id,
    input.userId,
    issuedAt,
    expiresAt,
    input.userAgent || '',
    input.ipAddress || '',
  );

  return {
    id,
    user_id: input.userId,
    issued_at: issuedAt,
    expires_at: expiresAt,
    revoked_at: null,
    user_agent: input.userAgent || '',
    ip_address: input.ipAddress || '',
  };
}

export function getActiveSessionById(sessionId: string): AuthSession | null {
  ensureAuthTables();
  cleanupExpiredAuthRecords();

  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM auth_sessions
    WHERE id = ?
      AND revoked_at IS NULL
      AND expires_at > ?
    LIMIT 1
  `).get(sessionId, nowIso()) as AuthSession | undefined;

  return row ?? null;
}

export function revokeSessionById(sessionId: string): void {
  ensureAuthTables();
  const db = getDb();
  db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(nowIso(), sessionId);
}

export function parseTransports(value: string): AuthenticatorTransportFuture[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is AuthenticatorTransportFuture => typeof item === 'string');
  } catch {
    return [];
  }
}

// ── Recovery Keys ──────────────────────────────────────────────────

export function createRecoveryKey(userId: string, keyHash: string, label?: string): AuthRecoveryKey {
  ensureAuthTables();
  const db = getDb();
  const id = makeId('rk');
  const now = nowIso();

  db.prepare(`
    INSERT INTO auth_recovery_keys (id, user_id, key_hash, label, created_at, last_used_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL)
  `).run(id, userId, keyHash, label || 'default', now);

  return { id, user_id: userId, key_hash: keyHash, label: label || 'default', created_at: now, last_used_at: null, revoked_at: null };
}

export function getActiveRecoveryKeyByHash(keyHash: string): AuthRecoveryKey | null {
  ensureAuthTables();
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM auth_recovery_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1',
  ).get(keyHash) as AuthRecoveryKey | undefined;
  return row ?? null;
}

export function listActiveRecoveryKeysForUser(userId: string): AuthRecoveryKey[] {
  ensureAuthTables();
  const db = getDb();
  return db.prepare(
    'SELECT * FROM auth_recovery_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
  ).all(userId) as AuthRecoveryKey[];
}

export function updateRecoveryKeyLastUsed(id: string): void {
  ensureAuthTables();
  const db = getDb();
  db.prepare('UPDATE auth_recovery_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), id);
}

export function revokeRecoveryKey(id: string): void {
  ensureAuthTables();
  const db = getDb();
  db.prepare('UPDATE auth_recovery_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), id);
}

export function revokeAllRecoveryKeysForUser(userId: string): void {
  ensureAuthTables();
  const db = getDb();
  db.prepare('UPDATE auth_recovery_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso(), userId);
}

export function hasActiveRecoveryKey(userId: string): boolean {
  ensureAuthTables();
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM auth_recovery_keys WHERE user_id = ? AND revoked_at IS NULL LIMIT 1').get(userId) as { 1: number } | undefined;
  return Boolean(row);
}
