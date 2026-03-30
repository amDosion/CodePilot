import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import type { RemoteConnection, RemoteTunnel } from '@/types';
import { buildSshBaseArgs, buildSshTarget } from '@/lib/remote-ssh';

interface RemoteTunnelRuntime {
  tunnel: RemoteTunnel;
  process: ChildProcess;
  logs: string[];
}

declare global {
  var __codepilot_remote_tunnels: Map<string, RemoteTunnelRuntime> | undefined;
}

function getStore(): Map<string, RemoteTunnelRuntime> {
  if (!globalThis.__codepilot_remote_tunnels) {
    globalThis.__codepilot_remote_tunnels = new Map<string, RemoteTunnelRuntime>();
  }
  return globalThis.__codepilot_remote_tunnels;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function listRemoteTunnels(): RemoteTunnel[] {
  return Array.from(getStore().values()).map((entry) => ({
    ...entry.tunnel,
    status: entry.process.exitCode === null ? 'running' : 'stopped',
    last_error: entry.tunnel.last_error,
  }));
}

export async function openRemoteTunnel(
  connection: RemoteConnection,
  options: { local_port: number; remote_host: string; remote_port: number },
): Promise<RemoteTunnel> {
  const id = crypto.randomBytes(16).toString('hex');
  const createdAt = nowIso();
  const tunnel: RemoteTunnel = {
    id,
    connection_id: connection.id,
    local_port: options.local_port,
    remote_host: options.remote_host,
    remote_port: options.remote_port,
    status: 'starting',
    created_at: createdAt,
    last_error: '',
    pid: null,
  };

  const sshArgs = [
    ...buildSshBaseArgs(connection, { batchMode: false }),
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `${options.local_port}:${options.remote_host}:${options.remote_port}`,
    buildSshTarget(connection),
  ];

  const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const runtime: RemoteTunnelRuntime = { tunnel: { ...tunnel, pid: child.pid ?? null }, process: child, logs: [] };
  getStore().set(id, runtime);

  const appendLog = (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    runtime.logs.push(text);
    runtime.tunnel.last_error = text;
  };

  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);

  child.on('exit', () => {
    runtime.tunnel.status = 'stopped';
    runtime.tunnel.pid = null;
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        runtime.tunnel.status = 'running';
        resolve();
        return;
      }
      reject(new Error(runtime.tunnel.last_error || 'SSH tunnel exited before becoming ready'));
    }, 500);
    if (typeof timer.unref === 'function') timer.unref();

    child.once('error', (error) => {
      clearTimeout(timer);
      runtime.tunnel.status = 'stopped';
      runtime.tunnel.last_error = error.message;
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      if (runtime.tunnel.status === 'running') {
        resolve();
      } else {
        reject(new Error(runtime.tunnel.last_error || 'SSH tunnel exited before becoming ready'));
      }
    });
  }).catch((error) => {
    getStore().delete(id);
    throw error;
  });

  return runtime.tunnel;
}

export function closeRemoteTunnel(id: string): boolean {
  const runtime = getStore().get(id);
  if (!runtime) return false;
  runtime.process.kill();
  getStore().delete(id);
  return true;
}
