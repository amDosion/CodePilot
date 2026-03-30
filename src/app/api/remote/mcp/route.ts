import { NextRequest, NextResponse } from 'next/server';
import { getRemoteConnection } from '@/lib/remote-connections';
import { runRemoteCommand, quoteShellArg } from '@/lib/remote-ssh';
import { normalizeEngineType } from '@/lib/engine-defaults';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getMcpConfigPath(engine: string): string {
  const resolved = normalizeEngineType(engine);
  if (resolved === 'codex') return '~/.codex/config.toml';
  if (resolved === 'gemini') return '~/.gemini/settings.json';
  return '~/.claude/.mcp.json';
}

function getMcpServersKey(engine: string): string {
  const resolved = normalizeEngineType(engine);
  if (resolved === 'codex') return 'mcpServers';
  if (resolved === 'gemini') return 'mcpServers';
  return 'mcpServers';
}

async function readRemoteMcpConfig(
  connection: Parameters<typeof runRemoteCommand>[0],
  engine: string,
): Promise<Record<string, unknown>> {
  const configPath = getMcpConfigPath(engine);
  const result = await runRemoteCommand(
    connection,
    `cat ${quoteShellArg(configPath)} 2>/dev/null || echo '{}'`,
    { timeoutMs: 10000 },
  );
  const raw = result.stdout.trim();
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeRemoteMcpConfig(
  connection: Parameters<typeof runRemoteCommand>[0],
  engine: string,
  config: Record<string, unknown>,
): Promise<void> {
  const configPath = getMcpConfigPath(engine);
  const dirPath = configPath.replace(/\/[^/]+$/, '');
  const content = JSON.stringify(config, null, 2);
  await runRemoteCommand(
    connection,
    `mkdir -p ${quoteShellArg(dirPath)} && cat > ${quoteShellArg(configPath)} << 'CODEPILOT_EOF'\n${content}\nCODEPILOT_EOF`,
    { timeoutMs: 10000 },
  );
}

/**
 * POST /api/remote/mcp
 * Manage MCP servers on a remote host.
 *
 * Body: { connection_id, engine_type?, action: 'list' | 'add' | 'update' | 'delete', server_name?, server_config? }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      connection_id?: string;
      engine_type?: string;
      action?: string;
      server_name?: string;
      server_config?: Record<string, unknown>;
    };

    const connectionId = (body.connection_id || '').trim();
    if (!connectionId) {
      return NextResponse.json({ error: 'connection_id is required' }, { status: 400 });
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Remote connection not found' }, { status: 404 });
    }

    const engine = normalizeEngineType(body.engine_type);
    const action = (body.action || 'list').trim();
    const serversKey = getMcpServersKey(engine);

    if (action === 'list') {
      const config = await readRemoteMcpConfig(connection, engine);
      const mcpServers = (config[serversKey] as Record<string, unknown>) || {};
      const configPath = getMcpConfigPath(engine);
      return NextResponse.json({ mcpServers, engine, path: configPath, format: 'json' });
    }

    if (action === 'add') {
      const { server_name, server_config } = body;
      if (!server_name || !server_config) {
        return NextResponse.json({ error: 'server_name and server_config are required' }, { status: 400 });
      }
      const config = await readRemoteMcpConfig(connection, engine);
      const servers = (config[serversKey] as Record<string, unknown>) || {};
      if (servers[server_name]) {
        return NextResponse.json({ error: `MCP server "${server_name}" already exists` }, { status: 409 });
      }
      servers[server_name] = server_config;
      config[serversKey] = servers;
      await writeRemoteMcpConfig(connection, engine, config);
      return NextResponse.json({ success: true });
    }

    if (action === 'update') {
      const { server_name, server_config } = body;
      if (!server_name || !server_config) {
        return NextResponse.json({ error: 'server_name and server_config are required' }, { status: 400 });
      }
      const config = await readRemoteMcpConfig(connection, engine);
      const servers = (config[serversKey] as Record<string, unknown>) || {};
      servers[server_name] = server_config;
      config[serversKey] = servers;
      await writeRemoteMcpConfig(connection, engine, config);
      return NextResponse.json({ success: true });
    }

    if (action === 'delete') {
      const { server_name } = body;
      if (!server_name) {
        return NextResponse.json({ error: 'server_name is required' }, { status: 400 });
      }
      const config = await readRemoteMcpConfig(connection, engine);
      const servers = (config[serversKey] as Record<string, unknown>) || {};
      delete servers[server_name];
      config[serversKey] = servers;
      await writeRemoteMcpConfig(connection, engine, config);
      return NextResponse.json({ success: true });
    }

    if (action === 'save_all') {
      const mcpServers = body.server_config || {};
      const config = await readRemoteMcpConfig(connection, engine);
      config[serversKey] = mcpServers;
      await writeRemoteMcpConfig(connection, engine, config);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to manage remote MCP config';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
