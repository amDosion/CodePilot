'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation } from '@/hooks/useTranslation';

interface AuthStatus {
  authenticated: boolean;
  hasPasskey?: boolean;
  hasRecoveryKey?: boolean;
  requiresSetup?: boolean;
  displayName?: string;
}

interface RecoveryKeyFile {
  version: number;
  type: string;
  userId: string;
  keyId: string;
  secret: string;
  createdAt: string;
  label: string;
}

interface AuthFlowOptionsPayload {
  token: string;
}

class HttpError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.data = data;
  }
}

function base64UrlToBuffer(input: string): ArrayBuffer {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function extractApiError(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const obj = data as Record<string, unknown>;
  const message = obj.error ?? obj.message ?? obj.detail;
  return typeof message === 'string' && message.trim() ? message : undefined;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw new HttpError(
      extractApiError(data) || `Request failed (${response.status})`,
      response.status,
      data,
    );
  }

  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseAuthStatus(payload: unknown): AuthStatus {
  if (!payload || typeof payload !== 'object') {
    return { authenticated: false };
  }

  const data = payload as Record<string, unknown>;
  const user = data.user && typeof data.user === 'object'
    ? data.user as Record<string, unknown>
    : null;

  const authenticated = data.authenticated === true
    || data.isAuthenticated === true
    || data.loggedIn === true
    || data.status === 'authenticated'
    || !!user;

  const hasPasskey = typeof data.hasPasskey === 'boolean'
    ? data.hasPasskey
    : (typeof data.has_passkey === 'boolean' ? data.has_passkey : undefined);

  const requiresSetup = data.needsSetup === true
    || data.needs_setup === true
    || data.setupRequired === true
    || data.passkey_setup_required === true
    || hasPasskey === false;

  const displayName = user?.displayName
    || user?.name
    || data.displayName
    || data.username;

  const hasRecoveryKey = typeof data.hasRecoveryKey === 'boolean'
    ? data.hasRecoveryKey
    : (typeof data.has_recovery_key === 'boolean' ? data.has_recovery_key : undefined);

  return {
    authenticated,
    hasPasskey,
    hasRecoveryKey,
    requiresSetup,
    displayName: typeof displayName === 'string' ? displayName : '',
  };
}

async function fetchAuthStatus(): Promise<AuthStatus> {
  const paths = ['/api/auth/status', '/api/auth/session'];
  let lastError: unknown = null;

  for (const path of paths) {
    try {
      const response = await fetch(path, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      });

      if (response.status === 404 || response.status === 405) {
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        return { authenticated: false };
      }

      const data = await parseJsonResponse(response);
      if (!response.ok) {
        throw new HttpError(
          extractApiError(data) || `Request failed (${response.status})`,
          response.status,
          data,
        );
      }

      return parseAuthStatus(data);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) throw lastError;
  return { authenticated: false };
}

function mapErrorMessage(error: unknown, fallback: string, passkeyCancelled: string): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return passkeyCancelled;
  }
  if (error instanceof HttpError) {
    return error.message || fallback;
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
}

function extractAuthFlowToken(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.token !== 'string' || !payload.token) {
    throw new Error('Auth challenge token is missing');
  }
  return payload.token;
}

function normalizeCreationOptions(payload: unknown): PublicKeyCredentialCreationOptions {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid setup options');
  const root = payload as Record<string, unknown>;
  const candidate = root.options && typeof root.options === 'object'
    ? root.options as Record<string, unknown>
    : root;
  const publicKey = candidate.publicKey && typeof candidate.publicKey === 'object'
    ? { ...(candidate.publicKey as Record<string, unknown>) }
    : { ...candidate };

  const challenge = publicKey.challenge;
  const user = publicKey.user;
  if (typeof challenge !== 'string' || !user || typeof user !== 'object') {
    throw new Error('Invalid setup options');
  }

  const userObj = { ...(user as Record<string, unknown>) };
  if (typeof userObj.id !== 'string') {
    throw new Error('Invalid setup options');
  }

  const exclude = Array.isArray(publicKey.excludeCredentials)
    ? publicKey.excludeCredentials.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const descriptor = { ...(item as Record<string, unknown>) };
        if (typeof descriptor.id === 'string') {
          descriptor.id = base64UrlToBuffer(descriptor.id);
        }
        return descriptor;
      })
    : undefined;

  userObj.id = base64UrlToBuffer(userObj.id);
  publicKey.challenge = base64UrlToBuffer(challenge);
  publicKey.user = userObj;
  if (exclude) {
    publicKey.excludeCredentials = exclude;
  }

  return publicKey as unknown as PublicKeyCredentialCreationOptions;
}

function normalizeRequestOptions(payload: unknown): PublicKeyCredentialRequestOptions {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid sign-in options');
  const root = payload as Record<string, unknown>;
  const candidate = root.options && typeof root.options === 'object'
    ? root.options as Record<string, unknown>
    : root;
  const publicKey = candidate.publicKey && typeof candidate.publicKey === 'object'
    ? { ...(candidate.publicKey as Record<string, unknown>) }
    : { ...candidate };

  const challenge = publicKey.challenge;
  if (typeof challenge !== 'string') {
    throw new Error('Invalid sign-in options');
  }

  const allow = Array.isArray(publicKey.allowCredentials)
    ? publicKey.allowCredentials.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const descriptor = { ...(item as Record<string, unknown>) };
        if (typeof descriptor.id === 'string') {
          descriptor.id = base64UrlToBuffer(descriptor.id);
        }
        return descriptor;
      })
    : undefined;

  publicKey.challenge = base64UrlToBuffer(challenge);
  if (allow) {
    publicKey.allowCredentials = allow;
  }

  return publicKey as unknown as PublicKeyCredentialRequestOptions;
}

function credentialToJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response;
  const base: Record<string, unknown> = {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment || null,
  };

  if ('attestationObject' in response) {
    const attestationResponse = response as AuthenticatorAttestationResponse;
    const transports = typeof attestationResponse.getTransports === 'function'
      ? attestationResponse.getTransports()
      : [];
    return {
      ...base,
      response: {
        clientDataJSON: bufferToBase64Url(attestationResponse.clientDataJSON),
        attestationObject: bufferToBase64Url(attestationResponse.attestationObject),
        transports,
      },
    };
  }

  const assertionResponse = response as AuthenticatorAssertionResponse;
  return {
    ...base,
    response: {
      clientDataJSON: bufferToBase64Url(assertionResponse.clientDataJSON),
      authenticatorData: bufferToBase64Url(assertionResponse.authenticatorData),
      signature: bufferToBase64Url(assertionResponse.signature),
      userHandle: assertionResponse.userHandle
        ? bufferToBase64Url(assertionResponse.userHandle)
        : null,
    },
  };
}

export default function LoginPage() {
  const router = useRouter();
  const { t } = useTranslation();

  const [checkingStatus, setCheckingStatus] = useState(true);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [activeTab, setActiveTab] = useState<'sign-in' | 'register'>('sign-in');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [actionState, setActionState] = useState<'sign-in' | 'register' | 'logout' | 'recovery' | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [passkeySupported, setPasskeySupported] = useState<boolean | null>(null);
  const [recoveryKeyFile, setRecoveryKeyFile] = useState<RecoveryKeyFile | null>(null);
  const [recoveryKeyDownloaded, setRecoveryKeyDownloaded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const registrationOpen = authStatus?.requiresSetup === true;
  const showRecoveryOption = !registrationOpen && (authStatus?.hasRecoveryKey === true || passkeySupported === false);

  const refreshAuthStatus = useCallback(async (redirectIfAuthenticated: boolean) => {
    setCheckingStatus(true);
    try {
      const status = await fetchAuthStatus();
      setAuthStatus(status);

      if (status.requiresSetup) {
        setActiveTab('register');
      }

      if (status.authenticated && redirectIfAuthenticated) {
        router.replace('/chat');
      }
    } catch (error) {
      setErrorMessage(mapErrorMessage(
        error,
        t('login.errorGeneric'),
        t('login.errorPasskeyCancelled'),
      ));
    } finally {
      setCheckingStatus(false);
    }
  }, [router, t]);

  useEffect(() => {
    refreshAuthStatus(true);
  }, [refreshAuthStatus]);

  useEffect(() => {
    setPasskeySupported(
      typeof window !== 'undefined'
      && typeof navigator !== 'undefined'
      && typeof PublicKeyCredential !== 'undefined'
      && !!navigator.credentials,
    );
  }, []);

  useEffect(() => {
    if (!registrationOpen && activeTab === 'register') {
      setActiveTab('sign-in');
    }
  }, [activeTab, registrationOpen]);

  const handleSignIn = useCallback(async () => {
    if (passkeySupported !== true) {
      setErrorMessage(t('login.errorUnsupported'));
      return;
    }

    setActionState('sign-in');
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const optionsPayload = await postJson('/api/auth/login/options', {}) as AuthFlowOptionsPayload;
      const token = extractAuthFlowToken(optionsPayload);
      const publicKey = normalizeRequestOptions(optionsPayload);

      const credential = await navigator.credentials.get({ publicKey });
      if (!credential || !(credential instanceof PublicKeyCredential)) {
        throw new Error(t('login.errorCredentialUnavailable'));
      }

      await postJson('/api/auth/login/verify', {
        token,
        response: credentialToJSON(credential),
      });

      setSuccessMessage(t('login.successSignedIn'));
      router.replace('/chat');
    } catch (error) {
      setErrorMessage(mapErrorMessage(
        error,
        t('login.errorGeneric'),
        t('login.errorPasskeyCancelled'),
      ));
    } finally {
      setActionState(null);
    }
  }, [passkeySupported, router, t]);

  const handleRegister = useCallback(async () => {
    if (passkeySupported !== true) {
      setErrorMessage(t('login.errorUnsupported'));
      return;
    }

    if (!registrationOpen) {
      setErrorMessage(t('login.errorSetupClosed'));
      return;
    }

    const normalizedUsername = username.trim();
    if (!normalizedUsername) {
      setErrorMessage(t('login.errorUsernameRequired'));
      return;
    }

    const normalizedDisplayName = displayName.trim() || normalizedUsername;

    setActionState('register');
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const optionsPayload = await postJson('/api/auth/register/options', {
        username: normalizedUsername,
        displayName: normalizedDisplayName,
      }) as AuthFlowOptionsPayload;
      const token = extractAuthFlowToken(optionsPayload);
      const publicKey = normalizeCreationOptions(optionsPayload);

      const credential = await navigator.credentials.create({ publicKey });
      if (!credential || !(credential instanceof PublicKeyCredential)) {
        throw new Error(t('login.errorCredentialUnavailable'));
      }

      const verifyResult = await postJson('/api/auth/register/verify', {
        token,
        response: credentialToJSON(credential),
      }) as Record<string, unknown>;

      // Show recovery key download dialog if the server returned one
      if (isRecord(verifyResult.recoveryKeyFile)) {
        setRecoveryKeyFile(verifyResult.recoveryKeyFile as unknown as RecoveryKeyFile);
        setSuccessMessage(t('login.successRegistered'));
        // Don't redirect yet — wait for user to save the key
        return;
      }

      setSuccessMessage(t('login.successRegistered'));
      router.replace('/chat');
    } catch (error) {
      setErrorMessage(mapErrorMessage(
        error,
        t('login.errorGeneric'),
        t('login.errorPasskeyCancelled'),
      ));
    } finally {
      setActionState(null);
    }
  }, [displayName, passkeySupported, registrationOpen, router, t, username]);

  const handleLogout = useCallback(async () => {
    setActionState('logout');
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok && response.status !== 401 && response.status !== 404) {
        const data = await parseJsonResponse(response);
        throw new HttpError(
          extractApiError(data) || `Logout failed (${response.status})`,
          response.status,
          data,
        );
      }

      await refreshAuthStatus(false);
    } catch (error) {
      setErrorMessage(mapErrorMessage(
        error,
        t('login.errorGeneric'),
        t('login.errorPasskeyCancelled'),
      ));
    } finally {
      setActionState(null);
    }
  }, [refreshAuthStatus, t]);

  const downloadRecoveryKey = useCallback(() => {
    if (!recoveryKeyFile) return;
    const blob = new Blob([JSON.stringify(recoveryKeyFile, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'codepilot-recovery.codepilot-key';
    a.click();
    URL.revokeObjectURL(url);
    setRecoveryKeyDownloaded(true);
  }, [recoveryKeyFile]);

  const handleRecoveryKeyContinue = useCallback(() => {
    setRecoveryKeyFile(null);
    setRecoveryKeyDownloaded(false);
    router.replace('/chat');
  }, [router]);

  const handleRecoveryKeyImport = useCallback(async (file: File) => {
    setActionState('recovery');
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const text = await file.text();
      let keyFile: unknown;
      try {
        keyFile = JSON.parse(text);
      } catch {
        throw new Error(t('login.recoveryKeyInvalidFile'));
      }

      if (
        !isRecord(keyFile)
        || keyFile.type !== 'codepilot-recovery-key'
        || typeof keyFile.secret !== 'string'
        || !keyFile.secret
      ) {
        throw new Error(t('login.recoveryKeyInvalidFile'));
      }

      await postJson('/api/auth/recovery-key/verify', { keyFile });
      setSuccessMessage(t('login.successSignedIn'));
      router.replace('/chat');
    } catch (error) {
      setErrorMessage(mapErrorMessage(
        error,
        t('login.errorGeneric'),
        t('login.errorPasskeyCancelled'),
      ));
    } finally {
      setActionState(null);
    }
  }, [router, t]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleRecoveryKeyImport(file);
    }
    e.target.value = '';
  }, [handleRecoveryKeyImport]);

  const statusBadge = useMemo(() => {
    if (!authStatus) {
      return <Badge variant="outline">{t('login.statusUnknown')}</Badge>;
    }
    if (authStatus.authenticated) {
      return <Badge>{t('login.statusAuthenticated')}</Badge>;
    }
    if (authStatus.requiresSetup) {
      return <Badge variant="secondary">{t('login.statusSetupRequired')}</Badge>;
    }
    if (authStatus.hasPasskey === true) {
      return <Badge variant="secondary">{t('login.statusPasskeyReady')}</Badge>;
    }
    return <Badge variant="outline">{t('login.statusUnknown')}</Badge>;
  }, [authStatus, t]);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-background via-background to-muted/20 px-4 py-10">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[-120px] h-72 w-72 -translate-x-1/2 rounded-full bg-primary/15 blur-3xl" />
        <div className="absolute bottom-[-80px] right-[-80px] h-72 w-72 rounded-full bg-cyan-500/10 blur-3xl" />
      </div>

      <Card className="relative w-full max-w-md border-border/60 bg-card/95 shadow-lg backdrop-blur">
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle>{t('login.title')}</CardTitle>
            {statusBadge}
          </div>
          <CardDescription>{t('login.subtitle')}</CardDescription>
          <Badge variant="outline" className="w-fit">{t('login.passkeyOnly')}</Badge>
        </CardHeader>

        <CardContent className="space-y-4">
          {checkingStatus && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              <span>{t('login.checkingStatus')}</span>
            </div>
          )}

          {authStatus?.displayName ? (
            <div className="text-sm text-muted-foreground">
              {authStatus.displayName}
            </div>
          ) : null}

          {passkeySupported === false && (
            <Alert variant="destructive">
              <AlertTitle>{t('login.notSupportedTitle')}</AlertTitle>
              <AlertDescription>
                {t('login.notSupportedDesc')}
                {authStatus?.hasRecoveryKey && (
                  <span className="block mt-1">{t('login.recoveryKeyNotSupportedHint')}</span>
                )}
              </AlertDescription>
            </Alert>
          )}

          {errorMessage && (
            <Alert variant="destructive">
              <AlertTitle>{t('error.title')}</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          {successMessage && (
            <Alert>
              <AlertTitle>{t('common.enabled')}</AlertTitle>
              <AlertDescription>{successMessage}</AlertDescription>
            </Alert>
          )}

          {registrationOpen ? (
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'sign-in' | 'register')}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="sign-in">{t('login.signInTab')}</TabsTrigger>
                <TabsTrigger value="register">{t('login.registerTab')}</TabsTrigger>
              </TabsList>

              <TabsContent value="sign-in" className="space-y-4 pt-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t('login.signInTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('login.signInDesc')}</p>
                </div>
                <Button
                  className="w-full"
                  onClick={handleSignIn}
                  disabled={passkeySupported !== true || !!actionState || checkingStatus}
                >
                  {actionState === 'sign-in' ? <Spinner className="size-4" /> : null}
                  {actionState === 'sign-in' ? t('login.signingIn') : t('login.signInButton')}
                </Button>
                <p className="text-xs text-muted-foreground">{t('login.useDevicePasskey')}</p>
              </TabsContent>

              <TabsContent value="register" className="space-y-4 pt-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t('login.registerTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('login.registerDesc')}</p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">{t('login.username')}</label>
                  <Input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('login.usernamePlaceholder')}
                    autoComplete="username webauthn"
                    disabled={!!actionState}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">{t('login.displayName')}</label>
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={t('login.displayNamePlaceholder')}
                    autoComplete="name"
                    disabled={!!actionState}
                  />
                </div>
                <Button
                  className="w-full"
                  onClick={handleRegister}
                  disabled={passkeySupported !== true || !!actionState || checkingStatus}
                >
                  {actionState === 'register' ? <Spinner className="size-4" /> : null}
                  {actionState === 'register' ? t('login.registering') : t('login.registerButton')}
                </Button>
              </TabsContent>
            </Tabs>
          ) : (
            <div className="space-y-4 pt-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">{t('login.signInTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('login.signInDesc')}</p>
              </div>
              {authStatus?.hasPasskey === true && (
                <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  {t('login.setupLockedDesc')}
                </div>
              )}
              <Button
                className="w-full"
                onClick={handleSignIn}
                disabled={passkeySupported !== true || !!actionState || checkingStatus}
              >
                {actionState === 'sign-in' ? <Spinner className="size-4" /> : null}
                {actionState === 'sign-in' ? t('login.signingIn') : t('login.signInButton')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('login.useDevicePasskey')}</p>

              {/* Recovery key import section */}
              {showRecoveryOption && (
                <>
                  <div className="relative my-2">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t" />
                    </div>
                    <div className="relative flex justify-center text-xs">
                      <span className="bg-card px-2 text-muted-foreground">{t('login.recoveryKeyOr')}</span>
                    </div>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".codepilot-key,.json"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!!actionState || checkingStatus}
                  >
                    {actionState === 'recovery' ? <Spinner className="size-4" /> : null}
                    {actionState === 'recovery' ? t('login.recoveryKeyImporting') : t('login.recoveryKeyImport')}
                  </Button>
                </>
              )}
            </div>
          )}
        </CardContent>

        <CardFooter className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            disabled={!!actionState || checkingStatus}
          >
            {actionState === 'logout' ? <Spinner className="size-4" /> : null}
            {actionState === 'logout' ? t('login.loggingOut') : t('login.logoutButton')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push('/chat')}
            disabled={!authStatus?.authenticated || !!actionState}
          >
            {t('login.goToChat')}
          </Button>
        </CardFooter>
      </Card>

      {/* Recovery key download dialog — shown after first registration */}
      <Dialog open={!!recoveryKeyFile}>
        <DialogContent className="sm:max-w-md" onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('login.recoveryKeyDialogTitle')}</DialogTitle>
            <DialogDescription>{t('login.recoveryKeyDialogDesc')}</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t('login.recoveryKeyDialogWarning')}
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button className="w-full" onClick={downloadRecoveryKey}>
              {recoveryKeyDownloaded ? t('login.recoveryKeyDownloaded') : t('login.recoveryKeyDownload')}
            </Button>
            <Button
              variant={recoveryKeyDownloaded ? 'default' : 'outline'}
              className="w-full"
              onClick={handleRecoveryKeyContinue}
            >
              {recoveryKeyDownloaded ? t('login.recoveryKeyContinue') : t('login.recoveryKeySkip')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
