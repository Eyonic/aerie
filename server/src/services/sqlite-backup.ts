import Database from 'better-sqlite3';
import type { BackupCallbacks } from './backup.js';

function integrityRows(database: any): string[] {
  const rows = database.pragma('integrity_check') as Array<Record<string, unknown>>;
  return rows.map(row => String(row.integrity_check ?? Object.values(row)[0] ?? ''));
}

export function validateSqliteDatabase(databasePath: string): void {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = integrityRows(database);
    if (rows.length !== 1 || rows[0].toLowerCase() !== 'ok') {
      throw new Error(`sqlite_integrity_check_failed:${rows.slice(0, 5).join(';')}`);
    }
    const foreignKeyErrors = database.pragma('foreign_key_check') as unknown[];
    if (foreignKeyErrors.length) throw new Error(`sqlite_foreign_key_check_failed:${foreignKeyErrors.length}`);
  } finally {
    database.close();
  }
}

// Each operation owns and closes its SQLite connection. The restore CLI uses
// the same adapter as the live API, so no connection remains open when the
// restart-time restore atomically replaces cloudbox.db.
export function sqliteBackupCallbacks(databasePath: string): BackupCallbacks {
  return {
    snapshotDatabase(destination: string) {
      const database = new Database(databasePath, { fileMustExist: true });
      try {
        database.pragma('busy_timeout = 30000');
        database.prepare('VACUUM INTO ?').run(destination);
      } finally {
        database.close();
      }
    },
    validateDatabase: validateSqliteDatabase,
  };
}
