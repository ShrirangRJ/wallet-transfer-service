import pg from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';
import { metrics } from './metrics.js';

/**
 * BIGINT (oid 20) arrives from the wire as a string because it does not fit in a JS
 * number in the general case. Parse it to `bigint` rather than `number` so that no
 * balance or amount is ever silently coerced through a float. Conversion to a JSON
 * number happens once, at the HTTP boundary, with an explicit safe-range assertion
 * (see money.ts).
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => BigInt(value));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  application_name: 'paytm-wallet',
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

pool.on('connect', (client) => {
  // A transfer only ever waits on two row locks, so a multi-second wait means something
  // is wedged. Failing the statement is better than pinning a pooled connection, and on a
  // free-tier Postgres the connection budget is small.
  void client
    .query(
      `SET statement_timeout = ${config.statementTimeoutMs};
       SET idle_in_transaction_session_timeout = ${config.statementTimeoutMs * 4};`,
    )
    .catch((err: unknown) => {
      logger.error({ event: 'db.session_setup_failed', err }, 'failed to configure session');
    });
});

pool.on('error', (err) => {
  // Idle-client errors are emitted on the pool, not on a query. Without this handler they
  // are unhandled 'error' events and take the process down.
  logger.error({ event: 'db.pool_error', err }, 'idle client error');
});

export type Tx = PoolClient;

/** Postgres error codes we care about by name instead of by magic string. */
export const PgErrorCode = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
} as const;

export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'constraint' in err) {
    const constraint = (err as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string') return constraint;
  }
  return undefined;
}

const RETRYABLE = new Set<string>([
  PgErrorCode.SERIALIZATION_FAILURE,
  PgErrorCode.DEADLOCK_DETECTED,
  PgErrorCode.LOCK_NOT_AVAILABLE,
]);

/**
 * Run `fn` inside a single READ COMMITTED transaction, retrying the whole transaction if
 * Postgres aborts it with a deadlock or serialization failure.
 *
 * READ COMMITTED is deliberate, not a default we ignored. Two behaviours depend on it:
 *
 *  1. `INSERT ... ON CONFLICT DO NOTHING` blocks on a conflicting *uncommitted* row until
 *     the other transaction ends. If that transaction committed, our insert affects zero
 *     rows -- and the follow-up SELECT in this same transaction must then be able to see
 *     the row the other transaction just committed. Under READ COMMITTED each statement
 *     takes a fresh snapshot, so it can. Under REPEATABLE READ the snapshot is pinned to
 *     the first statement, the SELECT would find nothing, and the idempotent-replay path
 *     would break.
 *  2. `UPDATE ... WHERE balance_paise >= $amount` re-evaluates its predicate against the
 *     latest committed row version after waiting on a concurrent writer's lock, which is
 *     exactly the semantics the conditional debit relies on.
 *
 * `fn` must be free of side effects outside the transaction, because it can be replayed.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  opts: { readOnly?: boolean; label: string } = { label: 'tx' },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.txMaxRetries; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query(
        opts.readOnly
          ? 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'
          : 'BEGIN ISOLATION LEVEL READ COMMITTED',
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        /* connection is already unusable; release() below discards it */
      });
      lastError = err;

      const code = pgErrorCode(err);
      if (code !== undefined && RETRYABLE.has(code) && attempt < config.txMaxRetries) {
        metrics.txRetries.inc({ label: opts.label, code });
        logger.warn(
          { event: 'db.tx_retry', label: opts.label, code, attempt },
          'retrying aborted transaction',
        );
        // Full jitter. Two transactions that just deadlocked must not retry in lockstep.
        await sleep(Math.random() * 10 * attempt);
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  throw lastError;
}

/** Single-statement query outside an explicit transaction (implicitly atomic). */
export async function query<R extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<R>> {
  return pool.query<R>(text, values as unknown[]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function closePool(): Promise<void> {
  await pool.end();
}
