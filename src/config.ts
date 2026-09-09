function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export const config = {
  port: optionalInt('PORT', 8080),
  host: process.env['HOST'] ?? '0.0.0.0',
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  nodeEnv: process.env['NODE_ENV'] ?? 'development',

  databaseUrl: required('DATABASE_URL'),
  /**
   * Managed Postgres on the free tiers (Render, Railway, Fly, Koyeb) terminates TLS with a
   * certificate chain that is not in the Node trust store. Enabling this turns TLS on with
   * `rejectUnauthorized: false`, which is the documented posture for those providers.
   */
  databaseSsl: optionalBool('DATABASE_SSL', false),
  pgPoolMax: optionalInt('PG_POOL_MAX', 10),

  /** Bearer token for the admin-only funding endpoint. */
  adminToken: required('ADMIN_TOKEN'),

  /** Retry budget for transactions aborted with 40001 (serialization) or 40P01 (deadlock). */
  txMaxRetries: optionalInt('TX_MAX_RETRIES', 5),

  /** Per-statement timeout, so a wedged lock wait cannot pin a connection forever. */
  statementTimeoutMs: optionalInt('STATEMENT_TIMEOUT_MS', 5_000),
} as const;

/** The pre-seeded wallet that funding transfers draw from. See migrations/001_init.sql. */
export const MINT_WALLET_ID = '00000000-0000-0000-0000-000000000001';
