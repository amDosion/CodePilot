import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RemoteConnection } from '@/types';
import { buildSshBaseArgs, buildSshTarget } from '@/lib/remote-ssh';

export type RemoteCliRuntime = 'claude' | 'codex';

interface RemoteCliWrapperOptions {
  runtime: RemoteCliRuntime;
  binary: string;
  connection: RemoteConnection;
  remotePath: string;
  localWorkingDirectory: string;
  forwardEnvNames?: string[];
}

function wrapperDirectory(): string {
  return path.join(os.homedir(), '.codepilot', 'remote-runtime-wrappers');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function buildWrapperScript(options: RemoteCliWrapperOptions): string {
  const config = {
    runtime: options.runtime,
    binary: options.binary,
    target: buildSshTarget(options.connection),
    sshArgs: buildSshBaseArgs(options.connection, { batchMode: false }),
    remotePath: options.remotePath,
    localWorkingDirectory: path.resolve(options.localWorkingDirectory),
    forwardEnvNames: Array.from(new Set(options.forwardEnvNames || [])).sort(),
  };

  return `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const path = require('node:path');
const config = ${JSON.stringify(config)};

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function toRemotePath(localValue) {
  const resolved = path.resolve(localValue);
  const localMirror = config.localWorkingDirectory;
  if (resolved === localMirror) return config.remotePath;
  if (!resolved.startsWith(localMirror + path.sep)) return localValue;
  const suffix = resolved.slice(localMirror.length + 1).split(path.sep).join('/');
  return config.remotePath.replace(/\/+$/, '') + '/' + suffix;
}

function remapArgs(args) {
  if (config.runtime !== 'codex') return args.slice();
  const rewritten = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if ((current === '--cd' || current === '--image' || current === '--add-dir') && index + 1 < args.length) {
      rewritten.push(current, toRemotePath(args[index + 1]));
      index += 1;
      continue;
    }
    rewritten.push(current);
  }
  return rewritten;
}

const args = remapArgs(process.argv.slice(2));
const envAssignments = [];
for (const name of config.forwardEnvNames) {
  const value = process.env[name];
  if (typeof value === 'string' && value.length > 0) {
    envAssignments.push(name + '=' + shellQuote(value));
  }
}

const commandParts = [];
if (envAssignments.length > 0) {
  commandParts.push('export ' + envAssignments.join(' ') + ';');
}
commandParts.push('cd ' + shellQuote(config.remotePath) + ';');
commandParts.push('exec ' + shellQuote(config.binary) + (args.length > 0 ? ' ' + args.map(shellQuote).join(' ') : ''));

const child = spawn('ssh', [...config.sshArgs, config.target, 'sh', '-lc', commandParts.join(' ')], {
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
`;
}

export function ensureRemoteCliWrapper(options: RemoteCliWrapperOptions): string {
  const directory = wrapperDirectory();
  fs.mkdirSync(directory, { recursive: true });

  const signature = stableJson({
    runtime: options.runtime,
    binary: options.binary,
    target: buildSshTarget(options.connection),
    sshArgs: buildSshBaseArgs(options.connection, { batchMode: false }),
    remotePath: options.remotePath,
    localWorkingDirectory: path.resolve(options.localWorkingDirectory),
    forwardEnvNames: Array.from(new Set(options.forwardEnvNames || [])).sort(),
  });
  const fileName = `${options.runtime}-${crypto.createHash('sha1').update(signature).digest('hex')}.cjs`;
  const wrapperPath = path.join(directory, fileName);

  if (!fs.existsSync(wrapperPath)) {
    fs.writeFileSync(wrapperPath, buildWrapperScript(options), { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(wrapperPath, 0o755);
  }

  return wrapperPath;
}
