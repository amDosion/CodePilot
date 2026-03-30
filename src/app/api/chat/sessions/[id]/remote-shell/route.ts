import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/db';
import { getRemoteConnection } from '@/lib/remote-connections';
import {
  clearRemoteShell,
  getRemoteShellSnapshot,
  resizeRemoteShell,
  sendRemoteShellInput,
  startRemoteShell,
  stopRemoteShell,
  subscribeRemoteShell,
  type RemoteShellEvent,
} from '@/lib/remote-shell-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();
const configuredHeartbeatMs = Number.parseInt(process.env.CODEPILOT_REMOTE_SHELL_HEARTBEAT_MS ?? '', 10);
const STREAM_HEARTBEAT_MS = Number.isFinite(configuredHeartbeatMs) && configuredHeartbeatMs > 0
  ? configuredHeartbeatMs
  : 15_000;

type ShellStreamEventType = RemoteShellEvent['type'] | 'heartbeat';

function encodeEvent(event: ShellStreamEventType, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function resolveRemoteSession(id: string) {
  const session = getSession(id);
  if (!session) {
    return { error: NextResponse.json({ error: 'Session not found' }, { status: 404 }) } as const;
  }
  if (session.workspace_transport !== 'ssh_direct') {
    return { error: NextResponse.json({ error: 'Session is not using a remote SSH workspace' }, { status: 400 }) } as const;
  }
  if (!session.remote_connection_id || !session.remote_path || !session.working_directory) {
    return { error: NextResponse.json({ error: 'Session remote workspace is incomplete' }, { status: 400 }) } as const;
  }
  return { session } as const;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<unknown> },
) {
  const { id } = await context.params as { id: string };
  const resolved = resolveRemoteSession(id);
  if ('error' in resolved) {
    return resolved.error;
  }

  let closeStream = () => {};
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      closeStream();
    },
    start(controller) {
      let closed = false;
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;

      closeStream = () => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        unsubscribe?.();
        request.signal.removeEventListener('abort', closeStream);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const send = (event: ShellStreamEventType, data: unknown) => {
        if (closed) return;
        controller.enqueue(encodeEvent(event, data));
      };

      send('snapshot', getRemoteShellSnapshot(id));
      heartbeatTimer = setInterval(() => {
        send('heartbeat', { timestamp: new Date().toISOString() });
      }, STREAM_HEARTBEAT_MS);
      heartbeatTimer.unref?.();

      unsubscribe = subscribeRemoteShell(id, (event) => {
        send(event.type, event.data);
      });

      request.signal.addEventListener('abort', closeStream, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<unknown> },
) {
  const { id } = await context.params as { id: string };
  const resolved = resolveRemoteSession(id);
  if ('error' in resolved) {
    return resolved.error;
  }

  const body = await request.json().catch(() => ({})) as {
    action?: 'start' | 'input' | 'stop' | 'clear' | 'resize';
    data?: string;
    cols?: number;
    rows?: number;
  };

  const action = body.action;
  if (!action) {
    return NextResponse.json({ error: 'action is required' }, { status: 400 });
  }

  try {
    if (action === 'start') {
      const connection = getRemoteConnection(resolved.session.remote_connection_id);
      if (!connection) {
        return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
      }
      const snapshot = await startRemoteShell(resolved.session, connection);
      return NextResponse.json({ success: true, snapshot });
    }

    if (action === 'input') {
      if (typeof body.data !== 'string' || body.data.length === 0) {
        return NextResponse.json({ error: 'data is required for input' }, { status: 400 });
      }
      const snapshot = sendRemoteShellInput(id, body.data);
      return NextResponse.json({ success: true, snapshot });
    }

    if (action === 'stop') {
      const snapshot = stopRemoteShell(id);
      return NextResponse.json({ success: true, snapshot });
    }

    if (action === 'clear') {
      const snapshot = clearRemoteShell(id);
      return NextResponse.json({ success: true, snapshot });
    }

    if (action === 'resize') {
      if (!Number.isFinite(body.cols) || !Number.isFinite(body.rows)) {
        return NextResponse.json({ error: 'cols and rows are required for resize' }, { status: 400 });
      }
      const snapshot = resizeRemoteShell(id, body.cols as number, body.rows as number);
      return NextResponse.json({ success: true, snapshot });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Remote shell request failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
