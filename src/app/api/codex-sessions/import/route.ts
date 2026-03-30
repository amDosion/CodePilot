import { NextRequest } from 'next/server';
import { parseCodexSession } from '@/lib/codex-session-parser';
import { createSession, addMessage, updateSdkSessionId, getAllSessions } from '@/lib/db';
import {
  normalizeReasoningEffort,
} from '@/lib/engine-defaults';
import { getCliDefaultsForEngine } from '@/lib/runtime-config';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return Response.json(
        { error: 'sessionId is required' },
        { status: 400 },
      );
    }

    // Reject duplicate imports for the same native session id.
    const existingSessions = getAllSessions();
    const alreadyImported = existingSessions.find(
      (s) => s.engine_session_id === sessionId || s.sdk_session_id === sessionId,
    );
    if (alreadyImported) {
      return Response.json(
        {
          error: 'This session has already been imported',
          existingSessionId: alreadyImported.id,
        },
        { status: 409 },
      );
    }

    const parsed = parseCodexSession(sessionId);
    if (!parsed) {
      return Response.json(
        { error: `Session "${sessionId}" not found or could not be parsed` },
        { status: 404 },
      );
    }

    const { info, messages } = parsed;
    if (messages.length === 0) {
      return Response.json(
        { error: 'Session has no messages to import' },
        { status: 400 },
      );
    }

    const firstUserMsg = messages.find((m) => m.role === 'user');
    const title = firstUserMsg
      ? firstUserMsg.content.slice(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '')
      : `Imported: ${info.projectName}`;

    const normalizedReasoning =
      normalizeReasoningEffort(info.reasoningEffort)
      || getCliDefaultsForEngine('codex').reasoningEffort;
    const model = info.model || getCliDefaultsForEngine('codex').model;

    const session = createSession(
      title,
      model,
      normalizedReasoning,
      undefined,
      info.cwd || info.projectPath,
      'code',
      'env',
      'codex',
      sessionId,
    );

    updateSdkSessionId(session.id, sessionId);

    for (const msg of messages) {
      const content = msg.hasToolBlocks
        ? JSON.stringify(msg.contentBlocks)
        : msg.content;
      if (content.trim()) {
        addMessage(session.id, msg.role, content);
      }
    }

    return Response.json({
      session: {
        id: session.id,
        title,
        messageCount: messages.length,
        projectPath: info.projectPath,
        engineSessionId: sessionId,
      },
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[POST /api/codex-sessions/import] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
