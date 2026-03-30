import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import posixPath from 'path/posix';
import os from 'os';
import { spawn as spawnPty, type IPty } from 'node-pty';
import type { RemoteConnection } from '@/types';
import { getExpandedPath, isWindows } from '@/lib/platform';

function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

const execFileAsync = promisify(execFile);

export interface RemoteCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RemoteShellProcess = IPty;

export function buildSshTarget(connection: RemoteConnection): string {
  const host = connection.host.trim();
  const username = (connection.username || '').trim();
  return username ? `${username}@${host}` : host;
}

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(args: string[]): string {
  return args.map((part) => quoteShellArg(part)).join(' ');
}

export function resolveInteractiveTerminalType(term = process.env.TERM): string {
  const normalized = (term || '').trim().toLowerCase();
  if (!normalized || normalized === 'dumb') {
    return 'xterm-256color';
  }
  return term as string;
}

function isExistingDirectory(candidate: string | null | undefined): candidate is string {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function resolvePtySpawnCwd(preferredCwd = process.cwd()): string {
  const candidates = [
    preferredCwd,
    process.env.PWD,
    os.homedir(),
    isWindows ? process.env.USERPROFILE : '/',
  ];

  for (const candidate of candidates) {
    if (isExistingDirectory(candidate)) {
      return candidate;
    }
  }

  return os.homedir();
}

let cachedSshBinaryPath: string | null = null;

export function resolveSshBinaryPath(): string {
  if (cachedSshBinaryPath && fs.existsSync(cachedSshBinaryPath)) {
    return cachedSshBinaryPath;
  }

  const staticCandidates = isWindows
    ? [
        'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
        'C:\\Windows\\Sysnative\\OpenSSH\\ssh.exe',
      ]
    : [
        '/usr/bin/ssh',
        '/bin/ssh',
        '/usr/local/bin/ssh',
        '/opt/homebrew/bin/ssh',
      ];

  for (const candidate of staticCandidates) {
    if (fs.existsSync(candidate)) {
      cachedSshBinaryPath = candidate;
      return candidate;
    }
  }

  try {
    const lookupCommand = isWindows ? 'where' : '/usr/bin/which';
    const output = execFileSync(lookupCommand, ['ssh'], {
      timeout: 3000,
      stdio: 'pipe',
      env: { ...process.env, PATH: getExpandedPath() },
      shell: isWindows,
    }).toString('utf8');
    for (const line of output.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && fs.existsSync(candidate)) {
        cachedSshBinaryPath = candidate;
        return candidate;
      }
    }
  } catch {
    // Fall through to final default below.
  }

  cachedSshBinaryPath = isWindows ? 'ssh.exe' : 'ssh';
  return cachedSshBinaryPath;
}

export function resolveNodePtySpawnHelperPath(): string | null {
  if (isWindows) {
    return null;
  }

  try {
    const nodePtyRoot = path.dirname(require.resolve('node-pty/package.json'));
    const helperPath = path.join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    return fs.existsSync(helperPath) ? helperPath : null;
  } catch {
    return null;
  }
}

export function ensureNodePtySpawnHelperExecutable(): void {
  const helperPath = resolveNodePtySpawnHelperPath();
  if (!helperPath) {
    return;
  }

  try {
    const stat = fs.statSync(helperPath);
    if ((stat.mode & 0o111) !== 0) {
      return;
    }
    fs.chmodSync(helperPath, stat.mode | 0o755);
  } catch (error) {
    throw new Error(
      `Failed to make node-pty spawn-helper executable (${helperPath}): ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

function buildPtySpawnEnv(terminalType: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  env.PATH = getExpandedPath();
  env.TERM = terminalType;
  return env;
}

export function buildSshBaseArgs(connection: RemoteConnection, options?: { batchMode?: boolean }): string[] {
  const args: string[] = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  ];

  if (options?.batchMode !== false) {
    args.push('-o', 'BatchMode=yes');
  }

  if (connection.port && Number(connection.port) !== 22) {
    args.push('-p', String(connection.port));
  }

  if (connection.auth_mode === 'key' && connection.private_key_path) {
    args.push('-i', expandTilde(connection.private_key_path));
  }

  return args;
}

export function buildSshProcessArgs(
  connection: RemoteConnection,
  commandArgs: string[],
  options?: { batchMode?: boolean },
): string[] {
  return [
    ...buildSshBaseArgs(connection, options),
    buildSshTarget(connection),
    ...commandArgs,
  ];
}

export function resolveRemoteAbsolutePath(connection: RemoteConnection, requestedPath: string): string {
  const trimmed = requestedPath.trim();
  if (!trimmed) {
    const root = (connection.remote_root || '').trim();
    if (!root) {
      throw new Error('Remote path is required');
    }
    return posixPath.normalize(root);
  }

  if (trimmed.startsWith('/')) {
    return posixPath.normalize(trimmed);
  }

  const remoteRoot = (connection.remote_root || '').trim();
  if (!remoteRoot) {
    throw new Error('This connection requires an absolute remote path because no remote root is configured');
  }

  return posixPath.normalize(posixPath.join(remoteRoot, trimmed));
}

export function assertRemotePathWithinRoot(connection: RemoteConnection, requestedPath: string): string {
  const absolutePath = resolveRemoteAbsolutePath(connection, requestedPath);
  const remoteRoot = (connection.remote_root || '').trim();
  if (!remoteRoot) {
    return absolutePath;
  }

  const normalizedRoot = posixPath.normalize(remoteRoot);
  if (absolutePath !== normalizedRoot && !absolutePath.startsWith(`${normalizedRoot}/`)) {
    throw new Error('Remote path is outside the configured remote root');
  }

  return absolutePath;
}

function buildRemoteShellCommand(command: string): string[] {
  return [`sh -lc ${quoteShellArg(command)}`];
}

async function execLocalCommand(command: string, args: string[], timeoutMs: number): Promise<RemoteCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const exitCode = typeof err.code === 'number' ? err.code : 1;
    throw new Error((err.stderr || err.stdout || err.message || `Command failed with code ${exitCode}`).trim());
  }
}

export async function runRemoteCommand(
  connection: RemoteConnection,
  command: string,
  options?: { timeoutMs?: number; cwd?: string },
): Promise<RemoteCommandResult> {
  const timeoutMs = options?.timeoutMs ?? 15000;
  const workingDirectory = options?.cwd ? resolveRemoteAbsolutePath(connection, options.cwd) : null;
  const finalCommand = workingDirectory
    ? `cd ${quoteShellArg(workingDirectory)} && ${command}`
    : command;

  return execLocalCommand('ssh', buildSshProcessArgs(connection, buildRemoteShellCommand(finalCommand)), timeoutMs);
}

export async function testRemoteConnection(connection: RemoteConnection): Promise<{ remotePwd: string }> {
  const marker = '__codepilot_remote_ok__';
  const result = await runRemoteCommand(connection, `printf ${quoteShellArg(marker)} && pwd`, { timeoutMs: 10000 });
  const output = result.stdout.trim();
  if (!output.startsWith(marker)) {
    throw new Error('SSH connection test did not return the expected marker');
  }
  return {
    remotePwd: output.slice(marker.length).trim(),
  };
}

export async function assertRemoteDirectoryExists(connection: RemoteConnection, remotePath: string): Promise<string> {
  const absolutePath = assertRemotePathWithinRoot(connection, remotePath);
  await runRemoteCommand(connection, `test -d ${quoteShellArg(absolutePath)}`);
  return absolutePath;
}

export async function ensureRemoteDirectory(connection: RemoteConnection, remotePath: string): Promise<string> {
  const absolutePath = assertRemotePathWithinRoot(connection, remotePath);
  await runRemoteCommand(connection, `mkdir -p ${quoteShellArg(absolutePath)}`);
  return absolutePath;
}

export async function spawnRemoteCommand(
  connection: RemoteConnection,
  command: string,
  options?: { cwd?: string },
): Promise<ChildProcess> {
  const workingDirectory = options?.cwd ? resolveRemoteAbsolutePath(connection, options.cwd) : null;
  const finalCommand = workingDirectory
    ? `cd ${quoteShellArg(workingDirectory)} && ${command}`
    : command;

  return spawn('ssh', buildSshProcessArgs(connection, buildRemoteShellCommand(finalCommand), { batchMode: false }), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function syncRemoteFile(
  connection: RemoteConnection,
  localPath: string,
  remoteFilePath: string,
): Promise<{ localPath: string; remotePath: string; stdout: string; stderr: string }> {
  const resolvedLocalPath = path.resolve(localPath);
  const absoluteRemotePath = assertRemotePathWithinRoot(connection, remoteFilePath);
  await runRemoteCommand(connection, `mkdir -p ${quoteShellArg(posixPath.dirname(absoluteRemotePath))}`);
  const scpArgs = [
    ...buildSshBaseArgs(connection, { batchMode: true }),
    resolvedLocalPath,
    `${buildSshTarget(connection)}:${absoluteRemotePath}`,
  ];
  const result = await execLocalCommand('scp', scpArgs, 2 * 60 * 1000);
  return {
    localPath: resolvedLocalPath,
    remotePath: absoluteRemotePath,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function uploadRemoteFileAtomic(
  connection: RemoteConnection,
  localPath: string,
  remoteFilePath: string,
  options?: { overwrite?: boolean },
): Promise<{ localPath: string; remotePath: string; tempPath: string; overwritten: boolean }> {
  const overwrite = options?.overwrite === true;
  const resolvedLocalPath = path.resolve(localPath);
  const absoluteRemotePath = assertRemotePathWithinRoot(connection, remoteFilePath);
  const remoteDir = posixPath.dirname(absoluteRemotePath);
  const tempPath = `${absoluteRemotePath}.codepilot-upload-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  let overwritten = false;

  await ensureRemoteDirectory(connection, remoteDir);

  if (overwrite) {
    try {
      await runRemoteCommand(connection, `test -e ${quoteShellArg(absoluteRemotePath)}`);
      overwritten = true;
    } catch {
      overwritten = false;
    }
  } else {
    try {
      await runRemoteCommand(connection, `test ! -e ${quoteShellArg(absoluteRemotePath)}`);
    } catch {
      throw new Error(`Remote file already exists: ${absoluteRemotePath}`);
    }
  }

  await syncRemoteFile(connection, resolvedLocalPath, tempPath);

  try {
    await runRemoteCommand(
      connection,
      overwrite
        ? `mv ${quoteShellArg(tempPath)} ${quoteShellArg(absoluteRemotePath)}`
        : `if [ -e ${quoteShellArg(absoluteRemotePath)} ]; then rm -f ${quoteShellArg(tempPath)}; exit 1; fi; mv ${quoteShellArg(tempPath)} ${quoteShellArg(absoluteRemotePath)}`,
    );
  } catch (error) {
    await runRemoteCommand(connection, `rm -f ${quoteShellArg(tempPath)}`).catch(() => {});
    if (error instanceof Error && error.message.includes('Remote file already exists')) {
      throw error;
    }
    throw new Error(`Failed to finalize remote upload: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  return {
    localPath: resolvedLocalPath,
    remotePath: absoluteRemotePath,
    tempPath,
    overwritten,
  };
}

export async function spawnRemoteShell(
  connection: RemoteConnection,
  options?: { cwd?: string; shell?: string; cols?: number; rows?: number },
): Promise<RemoteShellProcess> {
  const workingDirectory = options?.cwd ? resolveRemoteAbsolutePath(connection, options.cwd) : null;
  const shellCommand = options?.shell?.trim()
    ? `${quoteShellArg(options.shell.trim())} -l`
    : '${SHELL:-/bin/bash} -l';
  const terminalType = resolveInteractiveTerminalType();
  const finalCommand = [
    workingDirectory ? `cd ${quoteShellArg(workingDirectory)}` : '',
    `export TERM=${quoteShellArg(terminalType)}`,
    `exec ${shellCommand}`,
  ]
    .filter(Boolean)
    .join(' && ');
  const sshBinary = resolveSshBinaryPath();
  const localSpawnCwd = resolvePtySpawnCwd();
  ensureNodePtySpawnHelperExecutable();

  try {
    return spawnPty(sshBinary, [
      ...buildSshBaseArgs(connection, { batchMode: false }),
      '-tt',
      buildSshTarget(connection),
      ...buildRemoteShellCommand(finalCommand),
    ], {
      name: terminalType,
      cols: Math.max(20, options?.cols ?? 120),
      rows: Math.max(10, options?.rows ?? 32),
      cwd: localSpawnCwd,
      env: buildPtySpawnEnv(terminalType),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Failed to spawn local SSH PTY (ssh=${sshBinary}, cwd=${localSpawnCwd}): ${message}`);
  }
}
