import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME } from '@/lib/auth/constants';
import { verifySignedSessionToken } from '@/lib/auth/token';

const PUBLIC_PAGE_PATHS = new Set<string>(['/login']);
const PUBLIC_API_PREFIXES = ['/api/auth', '/api/health', '/api/runtime-commands', '/api/cli-defaults', '/api/cli-auth'];

const STATIC_FILE_PATTERN = /\.(?:css|js|mjs|map|png|jpg|jpeg|gif|svg|ico|webp|avif|txt|xml|woff|woff2|ttf|eot)$/i;

function isStaticResource(pathname: string): boolean {
  if (pathname.startsWith('/_next/')) return true;
  if (pathname.startsWith('/static/')) return true;
  if (pathname === '/favicon.ico') return true;
  return STATIC_FILE_PATTERN.test(pathname);
}

function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!token) {
    return false;
  }

  const claims = await verifySignedSessionToken(token);
  return Boolean(claims);
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isStaticResource(pathname)) {
    return NextResponse.next();
  }

  const authenticated = await hasValidSession(request);

  if (PUBLIC_PAGE_PATHS.has(pathname)) {
    if (authenticated) {
      return NextResponse.redirect(new URL('/chat', request.url));
    }
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    if (isPublicApiPath(pathname) || authenticated) {
      return NextResponse.next();
    }

    return NextResponse.json(
      { error: 'Authentication required', code: 'AUTH_REQUIRED' },
      { status: 401 },
    );
  }

  if (authenticated) {
    return NextResponse.next();
  }

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: '/:path*',
};
