import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db.js';
import { logger } from './logger.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'migrations');

/** Arbitrary but fixed key, so every instance contends for the same advisory lock. */
const MIGRATION_LOCK_KEY = 8_242_119;

/**
 * Applied at boot, before the server starts listening.
 *
 * This is what makes `docker compose up` and a fresh deploy both work with no manual
 * step: the schema is created by the app itself. Multiple instances booting at once are
 * serialized by a session-level advisory lock, and each file is applied inside its own
 * transaction with its version recorded, so a partially-applied migration cannot exist.
 */
export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    TEXT        PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    try {
      const applied = new Set(
        (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
          (row) => row.version,
        ),
      );

      const files = (await readdir(MIGRATIONS_DIR))
        .filter((name) => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b, 'en'));

      if (files.length === 0) {
        throw new Error(`no .sql files found in ${MIGRATIONS_DIR}`);
      }

      for (const file of files) {
        if (applied.has(file)) {
          logger.debug({ event: 'migration.skipped', version: file }, 'migration already applied');
          continue;
        }

        const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        const startedAt = Date.now();

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
        }

        logger.info(
          { event: 'migration.applied', version: file, duration_ms: Date.now() - startedAt },
          'migration applied',
        );
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
