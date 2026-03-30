import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import { runRemoteCommand } from '@/lib/remote-ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'OPENROUTER_API_KEY',
];

function maskValue(key: string, value: string): string {
  if (key.includes('URL') || key.includes('REGION') || key.includes('VERTEXAI')) {
    return value;
  }
  if (value.length > 8) {
    return '***' + value.slice(-8);
  }
  return '***';
}

/** POST: Detect environment variables on remote host */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { connection_id?: string };
    const connectionId = (body.connection_id || '').trim();
    if (!connectionId) {
      return NextResponse.json({ error: 'connection_id is required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    // Build a script to echo each env var's value
    const script = ENV_KEYS.map(
      (key) => `printf '%s=%s\\n' '${key}' "\${${key}:-}"`,
    ).join('; ');

    const result = await runRemoteCommand(connection, script, { timeoutMs: 10000 });

    const detected: Record<string, string> = {};
    for (const line of result.stdout.split('\n')) {
      const eqIdx = line.indexOf('=');
      if (eqIdx < 0) continue;
      const key = line.slice(0, eqIdx);
      const value = line.slice(eqIdx + 1).trim();
      if (value && ENV_KEYS.includes(key)) {
        detected[key] = maskValue(key, value);
      }
    }

    return NextResponse.json({
      env_detected: detected,
      providers: [],
      default_provider_id: '',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to detect remote providers';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
