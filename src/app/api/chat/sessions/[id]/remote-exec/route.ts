import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/db';
import { getRemoteConnection, markRemoteConnectionError, markRemoteConnectionSuccess } from '@/lib/remote-connections';
import { spawnRemoteCommand } from '@/lib/remote-ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

function encodeEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<unknown> },
) {
  const { id } = await context.params as { id: string };
  const session = getSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (session.workspace_transport !== 'ssh_direct') {
    return NextResponse.json({ error: 'Session is not using a remote SSH workspace' }, { status: 400 });
  }
  if (!session.remote_connection_id || !session.remote_path || !session.working_directory) {
    return NextResponse.json({ error: 'Session remote workspace is incomplete' }, { status: 400 });
  }

  const connection = getRemoteConnection(session.remote_connection_id);
  if (!connection) {
    return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({})) as { command?: string };
  const command = (body.command || '').trim();
  if (!command) {
    return NextResponse.json({ error: 'command is required' }, { status: 400 });
  }

  try {
    const child = await spawnRemoteCommand(connection, command, {
      cwd: session.remote_path,
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let finished = false;
        let clientAborted = request.signal.aborted;

        const safeEnqueue = (event: string, data: unknown) => {
          if (finished) return;
          try {
            controller.enqueue(encodeEvent(event, data));
          } catch {
            finished = true;
          }
        };

        const finish = () => {
          if (finished) return;
          finished = true;
          request.signal.removeEventListener('abort', handleAbort);
          try {
            controller.close();
          } catch {
            // stream already closed
          }
        };

        const handleAbort = () => {
          clientAborted = true;
          if (child.killed) {
            finish();
            return;
          }
          child.kill('SIGTERM');
        };

        request.signal.addEventListener('abort', handleAbort, { once: true });

        child.stdout?.on('data', (chunk: Buffer | string) => {
          safeEnqueue('stdout', chunk.toString());
        });

        child.stderr?.on('data', (chunk: Buffer | string) => {
          safeEnqueue('stderr', chunk.toString());
        });

        child.once('error', (error) => {
          markRemoteConnectionError(connection.id, error.message || 'Remote command failed');
          safeEnqueue('error', error.message || 'Remote command failed');
          safeEnqueue('done', { exit_code: null, signal: null, aborted: clientAborted });
          finish();
        });

        child.once('close', (code, signal) => {
          if (!clientAborted) {
            markRemoteConnectionSuccess(connection.id);
          }
          safeEnqueue('exit', {
            exit_code: typeof code === 'number' ? code : null,
            signal: signal ?? null,
            aborted: clientAborted,
          });
          safeEnqueue('done', {
            exit_code: typeof code === 'number' ? code : null,
            signal: signal ?? null,
            aborted: clientAborted,
          });
          finish();
        });

        safeEnqueue('start', {
          command,
          cwd: session.remote_path,
        });
      },
      cancel() {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Remote command failed';
    markRemoteConnectionError(connection.id, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
