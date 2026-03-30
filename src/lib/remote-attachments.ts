import fs from 'fs';
import path from 'path';
import posixPath from 'path/posix';
import type { FileAttachment, RemoteConnection } from '@/types';
import { syncRemoteFile } from '@/lib/remote-ssh';

export interface RemoteAttachmentFile {
  file: FileAttachment;
  localPath: string;
  remotePath: string;
}

function safeFileName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
}

function ensureLocalAttachmentPath(file: FileAttachment, localWorkingDirectory: string, index: number): string {
  if (file.filePath && fs.existsSync(file.filePath)) {
    return path.resolve(file.filePath);
  }

  const uploadDir = path.join(localWorkingDirectory, '.codepilot-uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const localPath = path.join(uploadDir, `${Date.now()}-${index}-${safeFileName(file.name)}`);
  fs.writeFileSync(localPath, Buffer.from(file.data, 'base64'));
  return localPath;
}

function toRemoteAttachmentPath(localPath: string, localWorkingDirectory: string, remotePath: string, index: number): string {
  const resolvedLocalPath = path.resolve(localPath);
  const resolvedLocalDir = path.resolve(localWorkingDirectory);
  if (resolvedLocalPath === resolvedLocalDir) {
    return remotePath;
  }
  if (resolvedLocalPath.startsWith(`${resolvedLocalDir}${path.sep}`)) {
    const relativePath = path.relative(resolvedLocalDir, resolvedLocalPath).split(path.sep).join('/');
    return posixPath.join(remotePath, relativePath);
  }
  return posixPath.join(remotePath, '.codepilot-uploads', `${index}-${safeFileName(path.basename(localPath))}`);
}

export async function syncAttachmentsToRemote(options: {
  files?: FileAttachment[];
  connection: RemoteConnection;
  localWorkingDirectory: string;
  remotePath: string;
}): Promise<RemoteAttachmentFile[]> {
  const files = options.files || [];
  const results: RemoteAttachmentFile[] = [];

  for (const [index, file] of files.entries()) {
    const localPath = ensureLocalAttachmentPath(file, options.localWorkingDirectory, index);
    const remoteFilePath = toRemoteAttachmentPath(localPath, options.localWorkingDirectory, options.remotePath, index);
    await syncRemoteFile(options.connection, localPath, remoteFilePath);
    results.push({
      file,
      localPath,
      remotePath: remoteFilePath,
    });
  }

  return results;
}
