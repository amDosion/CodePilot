import { NextRequest } from 'next/server';
import { syncConfigToFile } from '@/lib/config-sync';
import fs from 'node:fs/promises';
import {
  deleteSession,
  getSession,
  updateSessionWorkingDirectory,
  updateSessionTitle,
  updateSessionMode,
  updateSessionModel,
  updateSessionReasoningEffort,
  updateSessionProviderId,
  updateSessionEngineType,
  updateSdkSessionId,
  clearSessionMessages,
} from '@/lib/db';
import { normalizeEngineType } from '@/lib/engine-defaults';
import { getRemoteConnection } from '@/lib/remote-connections';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }
    return Response.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get session';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    const body = await request.json();
    let shouldClearEngineSession = false;

    if (body.working_directory) {
      const nextWorkingDirectory = String(body.working_directory || '').trim();
      if (!nextWorkingDirectory) {
        return Response.json({ error: 'Working directory is required' }, { status: 400 });
      }

      if (session.workspace_transport === 'ssh_direct') {
        if (!session.remote_connection_id) {
          return Response.json({ error: 'Remote connection is missing for this session' }, { status: 400 });
        }
        const connection = getRemoteConnection(session.remote_connection_id);
        if (!connection) {
          return Response.json({ error: 'Remote connection not found' }, { status: 404 });
        }
        return Response.json(
          { error: 'Remote working directory cannot be changed through this route; create a new remote session instead' },
          { status: 400 },
        );
      }

      try {
        await fs.access(nextWorkingDirectory);
      } catch {
        return Response.json({ error: 'Directory does not exist' }, { status: 400 });
      }

      updateSessionWorkingDirectory(id, nextWorkingDirectory);
    }
    if (body.title) {
      updateSessionTitle(id, body.title);
    }
    if (body.mode) {
      updateSessionMode(id, body.mode);
    }
    if (body.model !== undefined) {
      if ((body.model || '') !== (session.model || '')) {
        shouldClearEngineSession = true;
      }
      updateSessionModel(id, body.model);
    }
    if (body.reasoning_effort !== undefined) {
      updateSessionReasoningEffort(id, body.reasoning_effort);
    }
    if (body.provider_id !== undefined) {
      if ((body.provider_id || '') !== (session.provider_id || '')) {
        shouldClearEngineSession = true;
      }
      updateSessionProviderId(id, body.provider_id);
    }
    if (body.engine_type !== undefined) {
      const prevEngineType = normalizeEngineType(session.engine_type || 'claude');
      const nextEngineType = normalizeEngineType(body.engine_type || 'claude');
      if (prevEngineType !== nextEngineType) {
        shouldClearEngineSession = true;
      }
      updateSessionEngineType(id, body.engine_type);
    }
    if (shouldClearEngineSession) {
      // Model/engine switch must start a fresh runtime thread; otherwise resume can fail
      // with cross-model incompatibility errors.
      updateSdkSessionId(id, '');
    }
    if (body.clear_messages) {
      clearSessionMessages(id);
    }

    // Sync changes to CLI config files
    const engineType = normalizeEngineType(body.engine_type || session.engine_type || 'claude');
    syncConfigToFile(engineType, {
      model: body.model || undefined,
      mode: body.mode || undefined,
      reasoningEffort: body.reasoning_effort || undefined,
    });

    const updated = getSession(id);
    return Response.json({ session: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update session';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    deleteSession(id);
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete session';
    return Response.json({ error: message }, { status: 500 });
  }
}
