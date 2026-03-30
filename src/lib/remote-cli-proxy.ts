import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RemoteConnection } from '@/types';
import { getExpandedPath } from '@/lib/platform';
import { buildSshBaseArgs, buildSshTarget } from '@/lib/remote-ssh';

const dataDir = process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');
const runtimeDir = path.join(dataDir, 'runtime');
const proxyPath = path.join(runtimeDir, 'remote-cli-proxy.mjs');

const proxyScript = `#!/usr/bin/env node
import { spawn } from 'node:child_process';

function quoteShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function collectForwardedEnv() {
  const explicit = JSON.parse(process.env.CODEPILOT_REMOTE_ENV_JSON || '{}');
  const keys = (process.env.CODEPILOT_REMOTE_FORWARD_ENV_KEYS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const forwarded = { ...explicit };
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value !== '') {
      forwarded[key] = value;
    }
  }
  return forwarded;
}

const target = process.env.CODEPILOT_REMOTE_SSH_TARGET;
const executable = process.env.CODEPILOT_REMOTE_EXECUTABLE;
const baseArgs = JSON.parse(process.env.CODEPILOT_REMOTE_SSH_BASE_ARGS_JSON || '[]');
const remoteEnv = collectForwardedEnv();
const remoteCwd = process.env.CODEPILOT_REMOTE_WORKDIR || '';

if (!target || !executable) {
  process.stderr.write('Missing CODEPILOT_REMOTE_SSH_TARGET or CODEPILOT_REMOTE_EXECUTABLE\\n');
  process.exit(2);
}

const envExports = Object.entries(remoteEnv)
  .filter(([, value]) => typeof value === 'string' && value !== '')
  .map(([key, value]) => 'export ' + key + '=' + quoteShellArg(value))
  .join(' && ');

const commandParts = [];
if (remoteCwd) {
  commandParts.push('cd ' + quoteShellArg(remoteCwd));
}
if (envExports) {
  commandParts.push(envExports);
}
commandParts.push('exec ' + quoteShellArg(executable) + ' "$@"');

const child = spawn('ssh', [
  ...baseArgs,
  target,
  'sh',
  '-lc',
  commandParts.join(' && '),
  'sh',
  ...process.argv.slice(2),
], {
  stdio: 'inherit',
  env: { ...process.env, PATH: process.env.PATH || '' },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\\n');
  process.exit(1);
});
`;

export function ensureRemoteCliProxyPathSync(): string {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const needsWrite = !fs.existsSync(proxyPath) || fs.readFileSync(proxyPath, 'utf8') !== proxyScript;
  if (needsWrite) {
    fs.writeFileSync(proxyPath, proxyScript, 'utf8');
    fs.chmodSync(proxyPath, 0o755);
  }
  return proxyPath;
}

export async function ensureRemoteCliProxyPath(): Promise<string> {
  return ensureRemoteCliProxyPathSync();
}

export function buildRemoteCliProxyEnv(options: {
  connection: RemoteConnection;
  executable: string;
  remoteCwd?: string;
  inheritEnv?: Record<string, string>;
  remoteEnv?: Record<string, string>;
  forwardEnvKeys?: string[];
}): Record<string, string> {
  return {
    ...(options.inheritEnv || (process.env as Record<string, string>)),
    PATH: getExpandedPath(),
    CODEPILOT_REMOTE_EXECUTABLE: options.executable,
    CODEPILOT_REMOTE_SSH_TARGET: buildSshTarget(options.connection),
    CODEPILOT_REMOTE_SSH_BASE_ARGS_JSON: JSON.stringify(buildSshBaseArgs(options.connection, { batchMode: true })),
    CODEPILOT_REMOTE_WORKDIR: options.remoteCwd || '',
    CODEPILOT_REMOTE_ENV_JSON: JSON.stringify(options.remoteEnv || {}),
    CODEPILOT_REMOTE_FORWARD_ENV_KEYS: (options.forwardEnvKeys || []).join(','),
  };
}
