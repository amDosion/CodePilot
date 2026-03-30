import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import posixPath from 'node:path/posix';
import { simpleGit, type SimpleGit } from 'simple-git';
import { getSession } from '@/lib/db';
import { isPathSafe, isRootPath } from '@/lib/files';
import { getRemoteConnection } from '@/lib/remote-connections';
import { assertRemotePathWithinRoot, quoteShellArg, runRemoteCommand, shellJoin } from '@/lib/remote-ssh';
import type {
  GitBranches,
  GitCommitMessageSuggestion,
  GitCommitResult,
  GitFileStatus,
  GitLogEntry,
  GitRemote,
  GitRequestContext,
  GitStatus,
  GitTargetDescriptor,
  RemoteConnection,
  WorkspaceTransport,
} from '@/types';

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 120_000;
const FIELD_SEPARATOR = '\u001f';
const RECORD_SEPARATOR = '\u001e';

interface GitBaseTarget {
  cwd: string;
  scope_root: string;
  session_id?: string;
}

interface LocalGitTarget extends GitBaseTarget {
  mode: 'local';
}

interface RemoteGitTarget extends GitBaseTarget {
  mode: 'remote';
  connection: RemoteConnection;
  connection_id: string;
}

export type GitTarget = LocalGitTarget | RemoteGitTarget;

export class GitServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
    public readonly code: string = 'git_error',
  ) {
    super(message);
  }
}

function trimValue(value: string | undefined | null): string {
  return (value || '').trim();
}

export function readGitString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readGitBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }
  return false;
}

export function readGitNumber(value: unknown, fallback: number, options?: { min?: number; max?: number }): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const min = options?.min ?? Number.NEGATIVE_INFINITY;
  const max = options?.max ?? Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(min, parsed));
}

export function parseGitContextFromBody(body: Record<string, unknown>): GitRequestContext {
  return {
    session_id: readGitString(body.session_id),
    sessionId: readGitString(body.sessionId),
    cwd: readGitString(body.cwd),
    transport: readGitString(body.transport) as WorkspaceTransport,
    connection_id: readGitString(body.connection_id),
    connectionId: readGitString(body.connectionId),
    remote_path: readGitString(body.remote_path),
    remotePath: readGitString(body.remotePath),
  };
}

export function parseGitContextFromSearchParams(searchParams: URLSearchParams): GitRequestContext {
  return {
    session_id: trimValue(searchParams.get('session_id')),
    sessionId: trimValue(searchParams.get('sessionId')),
    cwd: trimValue(searchParams.get('cwd')),
    transport: trimValue(searchParams.get('transport')) as WorkspaceTransport,
    connection_id: trimValue(searchParams.get('connection_id')),
    connectionId: trimValue(searchParams.get('connectionId')),
    remote_path: trimValue(searchParams.get('remote_path')),
    remotePath: trimValue(searchParams.get('remotePath')),
  };
}

function normalizeTransport(value: string): WorkspaceTransport | '' {
  return value === 'ssh_direct' ? 'ssh_direct' : value === 'local' ? 'local' : '';
}

function ensureNonRootScope(scopeRoot: string): void {
  if (isRootPath(scopeRoot)) {
    throw new GitServiceError('Cannot use filesystem root as Git scope', 403, 'scope_violation');
  }
}

function resolveLocalPathWithinScope(scopeRoot: string, requestedPath: string): string {
  const candidate = trimValue(requestedPath);
  if (!candidate) {
    return scopeRoot;
  }

  const resolved = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(scopeRoot, candidate);

  if (!isPathSafe(scopeRoot, resolved)) {
    throw new GitServiceError('Path is outside the allowed workspace scope', 403, 'scope_violation');
  }

  return resolved;
}

function resolveRemotePathWithinScope(connection: RemoteConnection, scopeRoot: string, requestedPath: string): string {
  const candidate = trimValue(requestedPath);
  if (!candidate) {
    return scopeRoot;
  }

  const absolute = candidate.startsWith('/')
    ? assertRemotePathWithinRoot(connection, candidate)
    : assertRemotePathWithinRoot(connection, posixPath.join(scopeRoot, candidate));

  if (absolute !== scopeRoot && !absolute.startsWith(`${scopeRoot}/`)) {
    throw new GitServiceError('Remote path is outside the allowed workspace scope', 403, 'scope_violation');
  }

  return absolute;
}

function toLocalTarget(scopeRoot: string, cwd: string, sessionId?: string): LocalGitTarget {
  ensureNonRootScope(scopeRoot);
  return {
    mode: 'local',
    scope_root: scopeRoot,
    cwd,
    session_id: sessionId,
  };
}

function toRemoteTarget(
  connection: RemoteConnection,
  scopeRoot: string,
  cwd: string,
  sessionId?: string,
): RemoteGitTarget {
  return {
    mode: 'remote',
    connection,
    connection_id: connection.id,
    scope_root: scopeRoot,
    cwd,
    session_id: sessionId,
  };
}

export async function resolveGitTarget(input: GitRequestContext): Promise<GitTarget> {
  const sessionId = trimValue(input.session_id) || trimValue(input.sessionId);

  if (sessionId) {
    const session = getSession(sessionId);
    if (!session) {
      throw new GitServiceError('Session not found', 404, 'session_not_found');
    }

    if (session.workspace_transport === 'ssh_direct') {
      const connectionId = trimValue(session.remote_connection_id)
        || trimValue(input.connection_id)
        || trimValue(input.connectionId);
      if (!connectionId) {
        throw new GitServiceError('Remote connection is required for this session', 400, 'missing_remote_connection');
      }

      const connection = getRemoteConnection(connectionId);
      if (!connection) {
        throw new GitServiceError('Remote connection not found', 404, 'remote_connection_not_found');
      }

      const sessionRemotePath = trimValue(session.remote_path);
      if (!sessionRemotePath) {
        throw new GitServiceError('Session does not have a remote path', 400, 'missing_remote_path');
      }

      const scopeRoot = assertRemotePathWithinRoot(connection, sessionRemotePath);
      const requestedPath = trimValue(input.remote_path) || trimValue(input.remotePath) || trimValue(input.cwd);
      const cwd = resolveRemotePathWithinScope(connection, scopeRoot, requestedPath);
      return toRemoteTarget(connection, scopeRoot, cwd, sessionId);
    }

    const localBaseDir = trimValue(session.sdk_cwd) || trimValue(session.working_directory);
    if (!localBaseDir) {
      throw new GitServiceError('Session does not have a working directory', 400, 'missing_working_directory');
    }
    const scopeRoot = path.resolve(localBaseDir);
    const cwd = resolveLocalPathWithinScope(scopeRoot, trimValue(input.cwd));
    return toLocalTarget(scopeRoot, cwd, sessionId);
  }

  const inferredTransport = normalizeTransport(trimValue(input.transport))
    || (trimValue(input.connection_id) || trimValue(input.connectionId) || trimValue(input.remote_path) || trimValue(input.remotePath)
      ? 'ssh_direct'
      : 'local');

  if (inferredTransport === 'ssh_direct') {
    const connectionId = trimValue(input.connection_id) || trimValue(input.connectionId);
    if (!connectionId) {
      throw new GitServiceError('connection_id is required for remote Git operations', 400, 'missing_remote_connection');
    }

    const connection = getRemoteConnection(connectionId);
    if (!connection) {
      throw new GitServiceError('Remote connection not found', 404, 'remote_connection_not_found');
    }

    const scopeHint = trimValue(input.remote_path)
      || trimValue(input.remotePath)
      || trimValue(connection.remote_root)
      || trimValue(input.cwd);
    if (!scopeHint) {
      throw new GitServiceError('remote_path or cwd is required for remote Git operations', 400, 'missing_remote_path');
    }

    const scopeRoot = assertRemotePathWithinRoot(connection, scopeHint);
    const requestedPath = trimValue(input.cwd) || trimValue(input.remote_path) || trimValue(input.remotePath);
    const cwd = resolveRemotePathWithinScope(connection, scopeRoot, requestedPath);
    return toRemoteTarget(connection, scopeRoot, cwd);
  }

  const requestedCwd = trimValue(input.cwd);
  if (!requestedCwd) {
    throw new GitServiceError('cwd is required for local Git operations when session_id is not provided', 400, 'missing_cwd');
  }

  const scopeRoot = path.resolve(os.homedir());
  ensureNonRootScope(scopeRoot);
  const cwd = resolveLocalPathWithinScope(scopeRoot, requestedCwd);
  return toLocalTarget(scopeRoot, cwd);
}

export function describeGitTarget(target: GitTarget): GitTargetDescriptor {
  return {
    mode: target.mode,
    cwd: target.cwd,
    session_id: target.session_id,
    connection_id: target.mode === 'remote' ? target.connection_id : undefined,
  };
}

export function isGitServiceError(error: unknown): error is GitServiceError {
  return error instanceof GitServiceError;
}

function createLocalGit(target: LocalGitTarget): SimpleGit {
  return simpleGit({
    baseDir: target.cwd,
    binary: 'git',
    maxConcurrentProcesses: 1,
    trimmed: false,
  });
}

async function runLocalGit(target: LocalGitTarget, args: string[]): Promise<string> {
  return createLocalGit(target).raw(args);
}

async function runRemoteGit(target: RemoteGitTarget, args: string[], timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS): Promise<string> {
  const command = `git ${shellJoin(args)}`;
  const result = await runRemoteCommand(target.connection, command, {
    cwd: target.cwd,
    timeoutMs,
  });
  return result.stdout;
}


async function runGit(target: GitTarget, args: string[], timeoutMs?: number): Promise<string> {
  if (target.mode === 'local') {
    return runLocalGit(target, args);
  }
  return runRemoteGit(target, args, timeoutMs);
}

async function localPathExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function isGitRepo(target: GitTarget): Promise<boolean> {
  try {
    if (target.mode === 'local' && !(await localPathExists(target.cwd))) {
      return false;
    }

    const output = await runGit(target, ['rev-parse', '--is-inside-work-tree']);
    return output.trim() === 'true';
  } catch {
    return false;
  }
}

function createEmptyGitStatus(): GitStatus {
  return {
    is_repo: false,
    branch: '',
    tracking: null,
    ahead: 0,
    behind: 0,
    files: [],
    staged_count: 0,
    unstaged_count: 0,
    untracked_count: 0,
    clean: true,
  };
}

function inferStaging(index: string, workingDir: string): GitFileStatus['staging'] | undefined {
  if (index === '?' && workingDir === '?') {
    return 'unstaged';
  }
  if (index !== ' ' && workingDir !== ' ') {
    return 'partial';
  }
  if (index !== ' ') {
    return 'staged';
  }
  if (workingDir !== ' ') {
    return 'unstaged';
  }
  return undefined;
}

function parseAheadBehind(fragment: string | undefined): { ahead: number; behind: number } {
  const result = { ahead: 0, behind: 0 };
  if (!fragment) {
    return result;
  }

  for (const part of fragment.split(',')) {
    const normalized = part.trim();
    if (normalized.startsWith('ahead ')) {
      result.ahead = Number.parseInt(normalized.slice('ahead '.length), 10) || 0;
    } else if (normalized.startsWith('behind ')) {
      result.behind = Number.parseInt(normalized.slice('behind '.length), 10) || 0;
    }
  }

  return result;
}

function parseStatusBranchHeader(line: string): Pick<GitStatus, 'branch' | 'tracking' | 'ahead' | 'behind'> {
  const payload = line.slice(3).trim();

  if (!payload) {
    return { branch: '', tracking: null, ahead: 0, behind: 0 };
  }

  if (payload.startsWith('No commits yet on ')) {
    return {
      branch: payload.slice('No commits yet on '.length).trim(),
      tracking: null,
      ahead: 0,
      behind: 0,
    };
  }

  const detachedMatch = payload.match(/^HEAD \((.+)\)$/);
  if (detachedMatch) {
    return {
      branch: detachedMatch[1] || 'HEAD',
      tracking: null,
      ahead: 0,
      behind: 0,
    };
  }

  const match = payload.match(/^(.*?)(?:\.\.\.(.*?))?(?: \[(.+)\])?$/);
  if (!match) {
    return { branch: payload, tracking: null, ahead: 0, behind: 0 };
  }

  const aheadBehind = parseAheadBehind(match[3]);
  return {
    branch: (match[1] || '').trim(),
    tracking: trimValue(match[2]) || null,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
  };
}

function parseGitStatus(raw: string): GitStatus {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const status: GitStatus = {
    is_repo: true,
    branch: '',
    tracking: null,
    ahead: 0,
    behind: 0,
    files: [],
    staged_count: 0,
    unstaged_count: 0,
    untracked_count: 0,
    clean: true,
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      Object.assign(status, parseStatusBranchHeader(line));
      continue;
    }

    if (line.startsWith('!!')) {
      continue;
    }

    if (line.length < 3) {
      continue;
    }

    const index = line[0];
    const workingDir = line[1];
    let filePath = line.slice(3);
    let originalPath: string | undefined;

    if ((index === 'R' || index === 'C' || workingDir === 'R' || workingDir === 'C') && filePath.includes(' -> ')) {
      const renameParts = filePath.split(' -> ');
      originalPath = renameParts[0];
      filePath = renameParts[renameParts.length - 1];
    }

    const entry: GitFileStatus = {
      path: filePath,
      original_path: originalPath,
      index,
      working_dir: workingDir,
      staging: inferStaging(index, workingDir),
    };

    if (index !== ' ' && index !== '?') {
      status.staged_count += 1;
    }
    if (workingDir !== ' ' && workingDir !== '?') {
      status.unstaged_count += 1;
    }
    if (index === '?' && workingDir === '?') {
      status.untracked_count += 1;
    }

    status.files.push(entry);
  }

  status.clean = status.files.length === 0;
  return status;
}

export async function gitInit(target: GitTarget): Promise<void> {
  if (target.mode === 'local') {
    await fs.mkdir(target.cwd, { recursive: true });
    await runLocalGit(target, ['init']);
    return;
  }

  await runRemoteCommand(
    target.connection,
    `mkdir -p ${quoteShellArg(target.cwd)} && cd ${quoteShellArg(target.cwd)} && git init`,
    { timeoutMs: DEFAULT_GIT_TIMEOUT_MS },
  );
}

export async function gitStatus(target: GitTarget): Promise<GitStatus> {
  if (!(await isGitRepo(target))) {
    return createEmptyGitStatus();
  }

  const raw = await runGit(target, ['status', '--porcelain=v1', '--branch']);
  return parseGitStatus(raw);
}

function normalizeGitPath(target: GitTarget, filePath: string): string {
  const candidate = trimValue(filePath);
  if (!candidate) {
    throw new GitServiceError('File path is required', 400, 'missing_file_path');
  }

  if (target.mode === 'local') {
    const absolute = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(target.cwd, candidate);

    if (!isPathSafe(target.scope_root, absolute)) {
      throw new GitServiceError('File path is outside the allowed workspace scope', 403, 'scope_violation');
    }

    const relative = path.relative(target.cwd, absolute) || '.';
    return relative.split(path.sep).join('/');
  }

  const absolute = candidate.startsWith('/')
    ? assertRemotePathWithinRoot(target.connection, candidate)
    : assertRemotePathWithinRoot(target.connection, posixPath.join(target.cwd, candidate));

  if (absolute !== target.scope_root && !absolute.startsWith(`${target.scope_root}/`)) {
    throw new GitServiceError('Remote file path is outside the allowed workspace scope', 403, 'scope_violation');
  }

  return posixPath.relative(target.cwd, absolute) || '.';
}

function normalizeGitPaths(target: GitTarget, files: string[]): string[] {
  const normalized = files
    .map((file) => normalizeGitPath(target, file))
    .filter(Boolean);

  if (!normalized.length) {
    throw new GitServiceError('At least one file is required', 400, 'missing_files');
  }

  return normalized;
}

export async function gitDiff(
  target: GitTarget,
  options?: { staged?: boolean; filePath?: string; sha?: string },
): Promise<string> {
  if (!(await isGitRepo(target))) {
    return '';
  }

  const args = options?.sha
    ? ['show', '--format=medium', '--stat', '--patch', options.sha]
    : ['diff', options?.staged ? '--staged' : ''];

  const filteredArgs = args.filter(Boolean);
  if (options?.filePath) {
    filteredArgs.push('--', normalizeGitPath(target, options.filePath));
  }

  return runGit(target, filteredArgs);
}

export async function gitStage(target: GitTarget, files: string[]): Promise<void> {
  if (!files.length) {
    await gitStageAll(target);
    return;
  }

  await runGit(target, ['add', '--', ...normalizeGitPaths(target, files)]);
}

export async function gitStageAll(target: GitTarget): Promise<void> {
  await runGit(target, ['add', '--all']);
}

async function hasHead(target: GitTarget): Promise<boolean> {
  try {
    await runGit(target, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function gitUnstage(target: GitTarget, files: string[]): Promise<void> {
  const repoHasHead = await hasHead(target);
  const normalizedFiles = files.length ? normalizeGitPaths(target, files) : ['.'];

  if (repoHasHead) {
    await runGit(target, ['reset', '--quiet', 'HEAD', '--', ...normalizedFiles]);
    return;
  }

  await runGit(target, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...normalizedFiles]);
}

function mapCommitError(error: unknown): never {
  const message = error instanceof Error ? error.message : 'Failed to create commit';
  if (/nothing to commit|no changes added to commit/i.test(message)) {
    throw new GitServiceError('Nothing to commit', 409, 'nothing_to_commit');
  }
  if (/Author identity unknown|unable to auto-detect email address/i.test(message)) {
    throw new GitServiceError(message, 409, 'missing_git_identity');
  }
  throw error instanceof Error ? error : new Error(message);
}

export async function gitCommit(target: GitTarget, message: string): Promise<GitCommitResult> {
  const trimmedMessage = trimValue(message);
  if (!trimmedMessage) {
    throw new GitServiceError('Commit message is required', 400, 'missing_commit_message');
  }

  try {
    await runGit(target, ['commit', '-m', trimmedMessage]);
  } catch (error) {
    mapCommitError(error);
  }

  const sha = trimValue(await runGit(target, ['rev-parse', 'HEAD']));
  const status = await gitStatus(target);
  return {
    sha,
    short_sha: sha.slice(0, 7),
    branch: status.branch,
    summary: trimmedMessage.split(/\r?\n/, 1)[0] || trimmedMessage,
  };
}

export async function gitPush(target: GitTarget, remote?: string, branch?: string): Promise<void> {
  const args = ['push'];
  if (trimValue(remote)) {
    args.push(trimValue(remote));
  }
  if (trimValue(branch)) {
    args.push(trimValue(branch));
  }
  await runGit(target, args, CLONE_TIMEOUT_MS);
}

export async function gitPull(target: GitTarget, remote?: string, branch?: string): Promise<void> {
  const args = ['pull'];
  if (trimValue(remote)) {
    args.push(trimValue(remote));
  }
  if (trimValue(branch)) {
    args.push(trimValue(branch));
  }
  await runGit(target, args, CLONE_TIMEOUT_MS);
}

export async function gitFetch(target: GitTarget, remote?: string): Promise<void> {
  const args = ['fetch'];
  if (trimValue(remote)) {
    args.push(trimValue(remote));
  }
  await runGit(target, args, CLONE_TIMEOUT_MS);
}

export async function gitLog(target: GitTarget, maxCount: number = 50): Promise<GitLogEntry[]> {
  if (!(await isGitRepo(target))) {
    return [];
  }

  const count = Math.min(200, Math.max(1, maxCount));
  const format = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%D'].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;
  let raw = '';
  try {
    raw = await runGit(target, ['log', `--max-count=${String(count)}`, '--date=iso-strict', `--pretty=format:${format}`]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/does not have any commits yet|your current branch .* does not have any commits yet/i.test(message)) {
      return [];
    }
    throw error;
  }

  return raw
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, shortSha, author, email, date, message, refs] = record.split(FIELD_SEPARATOR);
      return {
        sha: sha || '',
        short_sha: shortSha || '',
        author: author || '',
        email: email || '',
        date: date || '',
        message: message || '',
        refs: refs || '',
      };
    });
}

async function listBranches(target: GitTarget, remote: boolean): Promise<string[]> {
  const args = remote
    ? ['branch', '--remotes', '--format=%(refname:short)']
    : ['branch', '--format=%(refname:short)'];
  const raw = await runGit(target, args);
  return raw
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function gitBranches(target: GitTarget): Promise<GitBranches> {
  if (!(await isGitRepo(target))) {
    return {
      current: '',
      local: [],
      remote: [],
    };
  }

  const [status, local, remote] = await Promise.all([
    gitStatus(target),
    listBranches(target, false),
    listBranches(target, true),
  ]);

  return {
    current: status.branch,
    local,
    remote,
  };
}

export async function gitCheckout(target: GitTarget, branch: string): Promise<void> {
  const trimmedBranch = trimValue(branch);
  if (!trimmedBranch) {
    throw new GitServiceError('Branch name is required', 400, 'missing_branch');
  }
  await runGit(target, ['checkout', trimmedBranch]);
}

export async function gitCreateBranch(target: GitTarget, name: string, startPoint?: string): Promise<void> {
  const trimmedName = trimValue(name);
  if (!trimmedName) {
    throw new GitServiceError('Branch name is required', 400, 'missing_branch');
  }

  const args = ['branch', trimmedName];
  if (trimValue(startPoint)) {
    args.push(trimValue(startPoint));
  }
  await runGit(target, args);
}

export async function gitDeleteBranch(target: GitTarget, name: string, force: boolean = false): Promise<void> {
  const trimmedName = trimValue(name);
  if (!trimmedName) {
    throw new GitServiceError('Branch name is required', 400, 'missing_branch');
  }
  await runGit(target, ['branch', force ? '-D' : '-d', trimmedName]);
}

export async function gitRemotes(target: GitTarget): Promise<GitRemote[]> {
  if (!(await isGitRepo(target))) {
    return [];
  }

  const raw = await runGit(target, ['remote', '-v']);
  const remotes = new Map<string, GitRemote>();

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) {
      continue;
    }

    const [, name, url, kind] = match;
    const entry = remotes.get(name) || {
      name,
      fetch_url: '',
      push_url: '',
    };
    if (kind === 'fetch') {
      entry.fetch_url = url;
    } else {
      entry.push_url = url;
    }
    remotes.set(name, entry);
  }

  return Array.from(remotes.values());
}

export async function gitAddRemote(target: GitTarget, name: string, url: string): Promise<void> {
  const trimmedName = trimValue(name);
  const trimmedUrl = trimValue(url);
  if (!trimmedName || !trimmedUrl) {
    throw new GitServiceError('Remote name and url are required', 400, 'missing_remote');
  }
  await runGit(target, ['remote', 'add', trimmedName, trimmedUrl]);
}

export async function gitRemoveRemote(target: GitTarget, name: string): Promise<void> {
  const trimmedName = trimValue(name);
  if (!trimmedName) {
    throw new GitServiceError('Remote name is required', 400, 'missing_remote');
  }
  await runGit(target, ['remote', 'remove', trimmedName]);
}

function normalizeCloneDestination(target: GitTarget, destination: string): string {
  const trimmedDestination = trimValue(destination);
  if (!trimmedDestination) {
    throw new GitServiceError('Clone destination is required', 400, 'missing_destination');
  }

  if (target.mode === 'local') {
    const absolute = path.isAbsolute(trimmedDestination)
      ? path.resolve(trimmedDestination)
      : path.resolve(target.cwd, trimmedDestination);

    if (!isPathSafe(target.scope_root, absolute)) {
      throw new GitServiceError('Clone destination is outside the allowed workspace scope', 403, 'scope_violation');
    }

    return absolute;
  }

  const absolute = trimmedDestination.startsWith('/')
    ? assertRemotePathWithinRoot(target.connection, trimmedDestination)
    : assertRemotePathWithinRoot(target.connection, posixPath.join(target.cwd, trimmedDestination));

  if (absolute !== target.scope_root && !absolute.startsWith(`${target.scope_root}/`)) {
    throw new GitServiceError('Remote clone destination is outside the allowed workspace scope', 403, 'scope_violation');
  }

  return absolute;
}

export async function gitClone(target: GitTarget, repositoryUrl: string, destination: string): Promise<string> {
  const trimmedRepositoryUrl = trimValue(repositoryUrl);
  if (!trimmedRepositoryUrl) {
    throw new GitServiceError('repository_url is required', 400, 'missing_repository_url');
  }

  if (target.mode === 'remote') {
    throw new GitServiceError('Remote clone is not supported; use explicit manual commands on the remote host instead', 403, 'remote_clone_unsupported');
  }

  const resolvedDestination = normalizeCloneDestination(target, destination);

  await fs.mkdir(path.dirname(resolvedDestination), { recursive: true });
  await createLocalGit(target).clone(trimmedRepositoryUrl, resolvedDestination, ['--progress']);
  return resolvedDestination;
}

export async function gitShowCommit(target: GitTarget, sha: string): Promise<string> {
  const trimmedSha = trimValue(sha);
  if (!trimmedSha) {
    throw new GitServiceError('sha is required', 400, 'missing_sha');
  }
  return gitDiff(target, { sha: trimmedSha });
}

function summarizeTouchedAreas(files: GitFileStatus[]): string {
  const areas = new Map<string, number>();

  for (const file of files) {
    const normalized = file.path.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    const area = segments.length > 1 ? segments[0] : 'root';
    areas.set(area, (areas.get(area) || 0) + 1);
  }

  return Array.from(areas.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([area]) => area)
    .join(', ');
}

function classifyCommitScope(files: GitFileStatus[]): string {
  const paths = files.map((file) => file.path.replace(/\\/g, '/'));

  if (paths.every((filePath) => filePath.endsWith('.md') || filePath.startsWith('docs/'))) {
    return 'docs';
  }
  if (paths.some((filePath) => filePath === 'package.json' || filePath === 'package-lock.json')) {
    return 'build';
  }
  if (paths.every((filePath) => /(^|\/)(__tests__|test|tests)\//.test(filePath) || /\.test\./.test(filePath))) {
    return 'test';
  }
  if (paths.every((filePath) => filePath.startsWith('src/app/api/git/') || filePath === 'src/lib/git.ts')) {
    return 'git';
  }
  if (paths.every((filePath) => filePath.startsWith('src/components/'))) {
    return 'ui';
  }
  return 'chore';
}

function classifyCommitVerb(files: GitFileStatus[]): string {
  const allAdded = files.every((file) => file.index === 'A' || (file.index === '?' && file.working_dir === '?'));
  const allDeleted = files.every((file) => file.index === 'D' || file.working_dir === 'D');

  if (allAdded) {
    return 'add';
  }
  if (allDeleted) {
    return 'remove';
  }
  return 'update';
}

function classifyCommitObject(files: GitFileStatus[]): string {
  if (files.length === 1) {
    return files[0].path.replace(/^\.?\//, '');
  }

  const areas = summarizeTouchedAreas(files);
  if (areas) {
    return `${areas} changes`;
  }

  return `${files.length} files`;
}

export async function gitGenerateCommitMessage(
  target: GitTarget,
  options?: { staged?: boolean },
): Promise<GitCommitMessageSuggestion> {
  const staged = options?.staged !== false;
  const status = await gitStatus(target);

  if (!status.is_repo) {
    return {
      message: '',
      summary: 'Current directory is not a Git repository',
      files: [],
      staged,
    };
  }

  const files = status.files.filter((file) => {
    if (staged) {
      return file.index !== ' ' && file.index !== '?';
    }
    return true;
  });

  if (!files.length) {
    return {
      message: '',
      summary: staged ? 'No staged changes to summarize' : 'No changes to summarize',
      files: [],
      staged,
    };
  }

  const scope = classifyCommitScope(files);
  const verb = classifyCommitVerb(files);
  const object = classifyCommitObject(files);
  const message = `${scope}: ${verb} ${object}`.slice(0, 72);
  const summary = `${files.length} file${files.length === 1 ? '' : 's'} changed across ${summarizeTouchedAreas(files) || 'the repository'}`;

  return {
    message,
    summary,
    files: files.slice(0, 10).map((file) => file.path),
    staged,
  };
}
