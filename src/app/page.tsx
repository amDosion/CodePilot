import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AUTH_COOKIE_NAME } from '@/lib/auth/constants';
import { ensureAuthTables, getActiveSessionById } from '@/lib/auth/store';
import { verifySignedSessionToken } from '@/lib/auth/token';

export const dynamic = 'force-dynamic';

async function hasAuthenticatedSession(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  if (!token) return false;

  const claims = await verifySignedSessionToken(token);
  if (!claims) return false;

  ensureAuthTables();
  const session = getActiveSessionById(claims.sid);
  return Boolean(session && session.user_id === claims.uid);
}

export default async function Home() {
  const authenticated = await hasAuthenticatedSession();
  redirect(authenticated ? '/chat' : '/login');
}
