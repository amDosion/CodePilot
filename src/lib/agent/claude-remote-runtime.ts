import os from 'os';
import path from 'path';
import type { ClaudeStreamOptions, FileAttachment } from '@/types';
import { getRemoteConnection } from '@/lib/remote-connections';
import { ensureRemoteCliWrapper } from '@/lib/remote-cli-wrapper';
import { resolveRemoteAbsolutePath } from '@/lib/remote-ssh';
import { prepareLocalAttachments, prepareRemoteAttachments } from '@/lib/agent/attachment-paths';

export interface ClaudePreparedAttachments {
  imageFiles: FileAttachment[];
  imageReferences: string[];
  nonImageReferences: string[];
}

function isRemoteClaude(options: ClaudeStreamOptions): boolean {
  return options.workspaceTransport === 'ssh_direct'
    && Boolean(options.remoteConnectionId)
    && Boolean(options.remotePath);
}

export function resolveClaudeExecutablePath(options: ClaudeStreamOptions, forwardEnvNames: string[]): string | undefined {
  if (!isRemoteClaude(options)) return undefined;
  const connection = getRemoteConnection((options.remoteConnectionId || '').trim());
  if (!connection) {
    throw new Error('Remote connection not found for Claude runtime.');
  }
  const remotePath = resolveRemoteAbsolutePath(connection, options.remotePath || '');
  const localWorkingDirectory = options.workingDirectory || os.homedir();
  return ensureRemoteCliWrapper({
    runtime: 'claude',
    binary: 'claude',
    connection,
    remotePath,
    localWorkingDirectory,
    forwardEnvNames,
  });
}

export async function prepareClaudeAttachments(options: ClaudeStreamOptions): Promise<ClaudePreparedAttachments> {
  const files = options.files || [];
  if (files.length === 0) {
    return { imageFiles: [], imageReferences: [], nonImageReferences: [] };
  }

  const workingDirectory = options.workingDirectory || os.homedir();
  const imageFiles = files.filter((file) => file.type.startsWith('image/'));
  const nonImageFiles = files.filter((file) => !file.type.startsWith('image/'));

  const buildReferences = async (selectedFiles: FileAttachment[]): Promise<string[]> => {
    if (selectedFiles.length === 0) return [];

    if (isRemoteClaude(options)) {
      const connection = getRemoteConnection((options.remoteConnectionId || '').trim());
      if (!connection) {
        throw new Error('Remote connection not found for Claude attachments.');
      }
      const remoteWorkspacePath = resolveRemoteAbsolutePath(connection, options.remotePath || '');
      const prepared = await prepareRemoteAttachments(selectedFiles, workingDirectory, connection, remoteWorkspacePath);
      return prepared.map((entry) => entry.remotePath);
    }

    const prepared = await prepareLocalAttachments(selectedFiles, workingDirectory);
    return prepared.map((entry) => path.resolve(entry.localPath));
  };

  const [imagePaths, nonImagePaths] = await Promise.all([
    buildReferences(imageFiles),
    buildReferences(nonImageFiles),
  ]);

  return {
    imageFiles,
    imageReferences: imagePaths.map((savedPath, index) => `[User attached image: ${savedPath} (${imageFiles[index].name})]`),
    nonImageReferences: nonImagePaths.map((savedPath, index) => `[User attached file: ${savedPath} (${nonImageFiles[index].name})]`),
  };
}
