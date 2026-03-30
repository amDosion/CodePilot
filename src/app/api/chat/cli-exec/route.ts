import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { normalizeEngineType, type EngineType } from '@/lib/engine-defaults';
import { buildClaudeSpawnCommand } from '@/lib/claude-cli';
import { buildCodexSpawnCommand } from '@/lib/codex-cli';
import { buildGeminiSpawnCommand } from '@/lib/gemini-cli';
import { getSession } from '@/lib/db';
import { getRemoteConnection, markRemoteConnectionError, markRemoteConnectionSuccess } from '@/lib/remote-connections';
import { runRemoteCommand } from '@/lib/remote-ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

const RUNTIME_BINARIES: Record<EngineType, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
};

function buildSpawnCommand(engine: EngineType, args: string[]) {
  switch (engine) {
    case 'claude':
      return buildClaudeSpawnCommand(args);
    case 'codex':
      return buildCodexSpawnCommand(args);
    case 'gemini':
      return buildGeminiSpawnCommand(args);
  }
}

async function executeLocal(
  engine: EngineType,
  cliCommand: string,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = cliCommand.split(/\s+/).filter(Boolean);
  const spawnCmd = buildSpawnCommand(engine, args);

  try {
    const { stdout, stderr } = await execFileAsync(spawnCmd.command, spawnCmd.args, {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      cwd: cwd || undefined,
      env: { ...spawnCmd.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const exitCode = typeof err.code === 'number' ? err.code : 1;
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || `Command failed with code ${exitCode}`,
      exitCode,
    };
  }
}

async function executeRemote(
  connectionId: string,
  engine: EngineType,
  cliCommand: string,
  remoteCwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const connection = getRemoteConnection(connectionId);
  if (!connection) {
    throw new Error('Remote connection not found');
  }

  const binary = RUNTIME_BINARIES[engine];
  const fullCommand = `${binary} ${cliCommand}`;

  try {
    const result = await runRemoteCommand(connection, fullCommand, {
      cwd: remoteCwd,
      timeoutMs: 30_000,
    });
    markRemoteConnectionSuccess(connection.id);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Remote command failed';
    markRemoteConnectionError(connection.id, message);
    return {
      stdout: '',
      stderr: message,
      exitCode: 1,
    };
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      engine_type?: string;
      cli_command?: string;
      cwd?: string;
      session_id?: string;
      connection_id?: string;
      remote_cwd?: string;
    };

    const cliCommand = (body.cli_command || '').trim();
    if (!cliCommand) {
      return NextResponse.json({ error: 'cli_command is required' }, { status: 400 });
    }

    const engine = normalizeEngineType(body.engine_type || 'claude');

    // Determine local vs remote execution
    let connectionId = body.connection_id;
    let remoteCwd = body.remote_cwd;

    // If session_id provided, check its transport mode
    if (body.session_id && !connectionId) {
      const session = getSession(body.session_id);
      if (session && session.workspace_transport === 'ssh_direct' && session.remote_connection_id) {
        connectionId = session.remote_connection_id;
        remoteCwd = remoteCwd || session.remote_path || undefined;
      }
    }

    let result: { stdout: string; stderr: string; exitCode: number };

    if (connectionId) {
      result = await executeRemote(connectionId, engine, cliCommand, remoteCwd);
    } else {
      result = await executeLocal(engine, cliCommand, body.cwd);
    }

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

    return NextResponse.json({
      output,
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
      engine,
      command: `${RUNTIME_BINARIES[engine]} ${cliCommand}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CLI execution failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
