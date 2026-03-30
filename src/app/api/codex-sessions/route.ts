import { listCodexSessions } from '@/lib/codex-session-parser';

export async function GET() {
  try {
    const sessions = listCodexSessions();
    return Response.json({ sessions });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[GET /api/codex-sessions] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
