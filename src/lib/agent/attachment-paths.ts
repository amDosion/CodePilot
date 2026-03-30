import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import posixPath from 'path/posix';
import type { FileAttachment, RemoteConnection } from '@/types';
import { syncRemoteFile } from '@/lib/remote-ssh';

export interface PreparedLocalAttachment {
  file: FileAttachment;
  localPath: string;
}

export interface PreparedRemoteAttachment extends PreparedLocalAttachment {
  remotePath: string;
}

function sanitizeName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
}

export async function ensureLocalAttachmentPath(file: FileAttachment, workingDirectory: string): Promise<string> {
  if (file.filePath && fs.existsSync(file.filePath)) {
    return file.filePath;
  }

  const uploadDir = path.join(workingDirectory, '.codepilot-uploads');
  await fsp.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, `${Date.now()}-${sanitizeName(file.name)}`);
  await fsp.writeFile(filePath, Buffer.from(file.data, 'base64'));
  return filePath;
}

export async function prepareLocalAttachments(
  files: FileAttachment[],
  workingDirectory: string,
): Promise<PreparedLocalAttachment[]> {
  return Promise.all(files.map(async (file) => ({
    file,
    localPath: await ensureLocalAttachmentPath(file, workingDirectory),
  })));
}

export async function prepareRemoteAttachments(
  files: FileAttachment[],
  workingDirectory: string,
  connection: RemoteConnection,
  remoteWorkspacePath: string,
): Promise<PreparedRemoteAttachment[]> {
  const prepared = await prepareLocalAttachments(files, workingDirectory);

  return Promise.all(prepared.map(async (entry) => {
    const remotePath = posixPath.join(remoteWorkspacePath, '.codepilot-uploads', path.basename(entry.localPath));
    await syncRemoteFile(connection, entry.localPath, remotePath);
    return {
      ...entry,
      remotePath,
    };
  }));
}
