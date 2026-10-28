import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schemaPath } from './config.ts';

const BUSY_TIMEOUT_MS = 5000;

export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  // Before WAL mode: SQLite gives the -wal and -shm files the mode of the main file. The unit's UMask covers a service run; this covers the rest.
  if (file !== ':memory:') fs.chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  ensureSchema(db);
  return db;
}

// The version is read inside the write transaction, so two processes opening a fresh database at once apply the schema once.
export function ensureSchema(db: DatabaseSync): void {
  inTransaction(db, () => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (row.user_version === 0) db.exec(fs.readFileSync(schemaPath, 'utf8'));
    // Version 2: a short summary of a tool call's input, when the mod sends one.
    if (row.user_version < 2) db.exec('ALTER TABLE tool_call ADD COLUMN detail TEXT; PRAGMA user_version = 2;');
  });
}

export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // SQLite already rolled back after some errors (SQLITE_FULL, INSERT OR ROLLBACK); a second ROLLBACK would throw over the real error.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
