import { NextRequest } from 'next/server';
import { parseGeminiSession } from '@/lib/gemini-session-parser';
import { addMessage, createSession, getAllSessions, updateSdkSessionId } from '@/lib/db';
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

    const parsed = parseGeminiSession(sessionId);
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

    const firstUserMsg = messages.find((message) => message.role === 'user');
    const title = firstUserMsg
      ? firstUserMsg.content.slice(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '')
      : `Imported: ${info.projectName}`;
    const model = info.model || getCliDefaultsForEngine('gemini').model;

    const session = createSession(
      title,
      model,
      '',
      undefined,
      info.cwd || info.projectPath,
      'code',
      'env',
      'gemini',
      sessionId,
    );

    updateSdkSessionId(session.id, sessionId);

    for (const message of messages) {
      if (!message.content.trim()) continue;
      addMessage(
        session.id,
        message.role,
        message.content,
        message.tokenUsage ? JSON.stringify(message.tokenUsage) : null,
      );
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
    console.error('[POST /api/gemini-sessions/import] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
