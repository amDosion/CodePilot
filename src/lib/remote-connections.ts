import crypto from 'crypto';
import { getDb } from '@/lib/db';
import type {
  RemoteConnection,
  CreateRemoteConnectionRequest,
  UpdateRemoteConnectionRequest,
} from '@/types';

function nowString(): string {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

function ensureRemoteConnectionTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      username TEXT NOT NULL DEFAULT '',
      auth_mode TEXT NOT NULL DEFAULT 'agent' CHECK(auth_mode IN ('agent', 'key')),
      private_key_path TEXT NOT NULL DEFAULT '',
      remote_root TEXT NOT NULL DEFAULT '',
      local_mirror_path TEXT NOT NULL DEFAULT '',
      options_json TEXT NOT NULL DEFAULT '{}',
      last_connected_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_remote_connections_updated_at ON remote_connections(updated_at);
  `);

  const columns = db.prepare('PRAGMA table_info(remote_connections)').all() as { name: string }[];
  const colNames = columns.map((column) => column.name);

  if (columns.length > 0 && !colNames.includes('options_json')) {
    db.exec("ALTER TABLE remote_connections ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (columns.length > 0 && !colNames.includes('last_connected_at')) {
    db.exec("ALTER TABLE remote_connections ADD COLUMN last_connected_at TEXT");
  }
  if (columns.length > 0 && !colNames.includes('last_error')) {
    db.exec("ALTER TABLE remote_connections ADD COLUMN last_error TEXT NOT NULL DEFAULT ''");
  }
}

function mapRemoteConnection(row: RemoteConnection): RemoteConnection {
  return {
    ...row,
    port: Number(row.port || 22),
    auth_mode: row.auth_mode === 'key' ? 'key' : 'agent',
    options_json: row.options_json || '{}',
    last_connected_at: row.last_connected_at || null,
  };
}

export function listRemoteConnections(): RemoteConnection[] {
  ensureRemoteConnectionTable();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM remote_connections ORDER BY updated_at DESC, name COLLATE NOCASE ASC').all() as RemoteConnection[];
  return rows.map(mapRemoteConnection);
}

export function getRemoteConnection(id: string): RemoteConnection | undefined {
  ensureRemoteConnectionTable();
  const db = getDb();
  const row = db.prepare('SELECT * FROM remote_connections WHERE id = ?').get(id) as RemoteConnection | undefined;
  return row ? mapRemoteConnection(row) : undefined;
}

export function createRemoteConnection(input: CreateRemoteConnectionRequest): RemoteConnection {
  ensureRemoteConnectionTable();
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = nowString();
  db.prepare(`
    INSERT INTO remote_connections (
      id, name, host, port, username, auth_mode, private_key_path,
      remote_root, options_json, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name.trim(),
    input.host.trim(),
    input.port || 22,
    (input.username || '').trim(),
    input.auth_mode === 'key' ? 'key' : 'agent',
    (input.private_key_path || '').trim(),
    (input.remote_root || '').trim(),
    input.options_json || '{}',
    '',
    now,
    now,
  );
  return getRemoteConnection(id)!;
}

export function updateRemoteConnection(id: string, input: UpdateRemoteConnectionRequest): RemoteConnection | undefined {
  ensureRemoteConnectionTable();
  const existing = getRemoteConnection(id);
  if (!existing) return undefined;

  const next: RemoteConnection = {
    ...existing,
    name: input.name !== undefined ? input.name.trim() : existing.name,
    host: input.host !== undefined ? input.host.trim() : existing.host,
    port: input.port !== undefined ? input.port : existing.port,
    username: input.username !== undefined ? input.username.trim() : existing.username,
    auth_mode: input.auth_mode !== undefined ? (input.auth_mode === 'key' ? 'key' : 'agent') : existing.auth_mode,
    private_key_path: input.private_key_path !== undefined ? input.private_key_path.trim() : existing.private_key_path,
    remote_root: input.remote_root !== undefined ? input.remote_root.trim() : existing.remote_root,
    options_json: input.options_json !== undefined ? input.options_json : existing.options_json,
    last_connected_at: existing.last_connected_at,
    last_error: existing.last_error,
    created_at: existing.created_at,
    updated_at: nowString(),
  };

  const db = getDb();
  db.prepare(`
    UPDATE remote_connections
    SET name = ?, host = ?, port = ?, username = ?, auth_mode = ?, private_key_path = ?,
        remote_root = ?, options_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.name,
    next.host,
    next.port,
    next.username,
    next.auth_mode,
    next.private_key_path,
    next.remote_root,
    next.options_json,
    next.updated_at,
    id,
  );

  return getRemoteConnection(id);
}

export function deleteRemoteConnection(id: string): boolean {
  ensureRemoteConnectionTable();
  const db = getDb();
  const result = db.prepare('DELETE FROM remote_connections WHERE id = ?').run(id);
  return result.changes > 0;
}

export function markRemoteConnectionSuccess(id: string): void {
  ensureRemoteConnectionTable();
  const db = getDb();
  const now = nowString();
  db.prepare('UPDATE remote_connections SET last_connected_at = ?, last_error = ?, updated_at = ? WHERE id = ?').run(now, '', now, id);
}

export function markRemoteConnectionError(id: string, error: string): void {
  ensureRemoteConnectionTable();
  const db = getDb();
  db.prepare('UPDATE remote_connections SET last_error = ?, updated_at = ? WHERE id = ?').run(error, nowString(), id);
}
