import { isSecureCookie, getSessionSecret } from '@/lib/auth/constants';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HMAC_ALGO: HmacImportParams = { name: 'HMAC', hash: 'SHA-256' };

export interface SessionTokenClaims {
  v: 1;
  sid: string;
  uid: string;
  iat: number;
  exp: number;
}

interface CreateSessionTokenInput {
  sessionId: string;
  userId: string;
  maxAgeSeconds: number;
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function getWebCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto is not available in this runtime');
  }
  return globalThis.crypto;
}

function encodeBase64Url(input: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input).toString('base64url');
  }

  let binary = '';
  for (let i = 0; i < input.length; i += 1) {
    binary += String.fromCharCode(input[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(input: string): Uint8Array | null {
  try {
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(input, 'base64url'));
    }

    const padded = input
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(input.length / 4) * 4, '=');
    const binary = atob(padded);
    const output = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      output[i] = binary.charCodeAt(i);
    }
    return output;
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const cached = hmacKeyCache.get(secret);
  if (cached) {
    return cached;
  }

  const keyPromise = getWebCrypto().subtle.importKey(
    'raw',
    encoder.encode(secret),
    HMAC_ALGO,
    false,
    ['sign', 'verify'],
  );
  hmacKeyCache.set(secret, keyPromise);
  return keyPromise;
}

function parseClaims(payloadJson: string): SessionTokenClaims | null {
  try {
    const parsed = JSON.parse(payloadJson) as Partial<SessionTokenClaims>;
    if (parsed.v !== 1) return null;
    if (!parsed.sid || !parsed.uid) return null;
    if (typeof parsed.iat !== 'number' || typeof parsed.exp !== 'number') return null;
    return {
      v: 1,
      sid: parsed.sid,
      uid: parsed.uid,
      iat: parsed.iat,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

async function signPayload(payload: string): Promise<string> {
  const key = await getHmacKey(getSessionSecret());
  const signature = await getWebCrypto().subtle.sign(HMAC_ALGO, key, encoder.encode(payload));
  return encodeBase64Url(new Uint8Array(signature));
}

export async function createSignedSessionToken(input: CreateSessionTokenInput): Promise<{ token: string; claims: SessionTokenClaims }> {
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionTokenClaims = {
    v: 1,
    sid: input.sessionId,
    uid: input.userId,
    iat: now,
    exp: now + input.maxAgeSeconds,
  };

  const payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await signPayload(payload);

  return {
    token: `${payload}.${signature}`,
    claims,
  };
}

export async function verifySignedSessionToken(token: string): Promise<SessionTokenClaims | null> {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const signatureBytes = decodeBase64Url(signature);
  if (!signatureBytes) return null;

  const key = await getHmacKey(getSessionSecret());
  const isValidSignature = await getWebCrypto().subtle.verify(
    HMAC_ALGO,
    key,
    toArrayBuffer(signatureBytes),
    encoder.encode(payload),
  );

  if (!isValidSignature) return null;

  const payloadBytes = decodeBase64Url(payload);
  if (!payloadBytes) return null;

  const claims = parseClaims(decoder.decode(payloadBytes));
  if (!claims) return null;

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) return null;

  return claims;
}

export function getSessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureCookie(),
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function getClearSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureCookie(),
    path: '/',
    maxAge: 0,
    expires: new Date(0),
  };
}
