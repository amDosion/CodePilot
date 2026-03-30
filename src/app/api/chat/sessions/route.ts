import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import { getAllSessions, createSession, getSession } from '@/lib/db';
import { readRuntimeSettings } from '@/lib/runtime-config';
import { normalizeEngineType } from '@/lib/engine-defaults';
import { getRemoteConnection, markRemoteConnectionError, markRemoteConnectionSuccess } from '@/lib/remote-connections';
import type { CreateSessionRequest, SessionsResponse, SessionResponse } from '@/types';

export async function GET() {
  try {
    const sessions = getAllSessions();
    const response: SessionsResponse = { sessions };
    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[GET /api/chat/sessions] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: CreateSessionRequest = await request.json();

    const workspaceTransport = body.workspace_transport === 'ssh_direct' ? 'ssh_direct' : 'local';
    let workingDirectory = (body.working_directory || '').trim();
    let remoteConnectionId = '';
    let remotePath = '';

    if (workspaceTransport === 'ssh_direct') {
      remoteConnectionId = (body.remote_connection_id || '').trim();
      remotePath = (body.remote_path || '').trim();
      const sourceSessionId = (body.source_session_id || '').trim();
      if (!remoteConnectionId || (!remotePath && !sourceSessionId)) {
        return Response.json(
          { error: 'remote_connection_id and either remote_path or source_session_id are required for remote sessions', code: 'MISSING_REMOTE_WORKSPACE' },
          { status: 400 },
        );
      }

      const connection = getRemoteConnection(remoteConnectionId);
      if (!connection) {
        return Response.json(
          { error: 'Remote connection not found', code: 'REMOTE_CONNECTION_NOT_FOUND' },
          { status: 404 },
        );
      }

      if (sourceSessionId) {
        const sourceSession = getSession(sourceSessionId);
        if (!sourceSession) {
          return Response.json(
            { error: 'Source session not found', code: 'SOURCE_SESSION_NOT_FOUND' },
            { status: 404 },
          );
        }
        if (sourceSession.workspace_transport !== 'ssh_direct') {
          return Response.json(
            { error: 'Source session is not using a remote SSH workspace', code: 'SOURCE_SESSION_NOT_REMOTE' },
            { status: 400 },
          );
        }
        if ((sourceSession.remote_connection_id || '').trim() !== connection.id) {
          return Response.json(
            { error: 'Source session does not belong to the selected remote connection', code: 'SOURCE_SESSION_CONNECTION_MISMATCH' },
            { status: 400 },
          );
        }

        const inheritedRemotePath = (sourceSession.remote_path || sourceSession.working_directory || '').trim();
        if (!inheritedRemotePath) {
          return Response.json(
            { error: 'Source session remote workspace is incomplete', code: 'SOURCE_SESSION_PATH_MISSING' },
            { status: 400 },
          );
        }

        remotePath = inheritedRemotePath;
      } else {
        // ssh_direct: resolve remote path, use it directly (no local mirror)
        const { assertRemotePathWithinRoot } = await import('@/lib/remote-ssh');
        try {
          remotePath = assertRemotePathWithinRoot(connection, remotePath);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid remote path';
          markRemoteConnectionError(connection.id, message);
          return Response.json(
            { error: message, code: 'INVALID_REMOTE_PATH' },
            { status: 400 },
          );
        }
      }
      workingDirectory = remotePath;
      markRemoteConnectionSuccess(connection.id);
    } else {
      if (!workingDirectory) {
        return Response.json(
          { error: 'Working directory is required', code: 'MISSING_DIRECTORY' },
          { status: 400 },
        );
      }

      try {
        await fs.access(workingDirectory);
      } catch {
        return Response.json(
          { error: 'Directory does not exist', code: 'INVALID_DIRECTORY' },
          { status: 400 },
        );
      }
    }

    // Read CLI config defaults when frontend doesn't provide values
    const engineType = normalizeEngineType(body.engine_type);
    let effectiveModel = body.model;
    let effectiveReasoningEffort = body.reasoning_effort;
    if (!effectiveModel || !effectiveReasoningEffort) {
      try {
        const cliSettings = readRuntimeSettings(engineType);
        if (!effectiveModel) {
          effectiveModel = engineType === 'codex'
            ? (typeof cliSettings.model === 'string' ? cliSettings.model : '')
            : engineType === 'gemini'
              ? (typeof cliSettings.model === 'string' ? cliSettings.model : '')
              : (typeof cliSettings.model === 'string' ? cliSettings.model : '');
        }
        if (!effectiveReasoningEffort) {
          effectiveReasoningEffort = engineType === 'codex'
            ? (typeof cliSettings.model_reasoning_effort === 'string' ? cliSettings.model_reasoning_effort : '')
            : (typeof cliSettings.reasoningEffort === 'string' ? cliSettings.reasoningEffort : '');
        }
      } catch { /* fallback to frontend-provided or empty */ }
    }

    const session = createSession(
      body.title,
      effectiveModel,
      effectiveReasoningEffort,
      body.system_prompt,
      workingDirectory,
      body.mode,
      body.provider_id,
      body.engine_type,
      body.engine_session_id,
      workspaceTransport,
      remoteConnectionId,
      remotePath,
    );
    const response: SessionResponse = { session };
    return Response.json(response, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[POST /api/chat/sessions] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
