import { pino, type LoggerOptions } from 'pino';
import { config } from './config.js';

/**
 * Structured JSON to stdout. No pretty-printing and no transports: `docker compose logs` and
 * every free deploy target (Render / Railway / Fly / Koyeb) collect stdout, and one JSON
 * object per line is what makes those logs greppable and shippable.
 *
 * These options are shared with Fastify (see server.ts) rather than handing Fastify a
 * prebuilt instance, so request-scoped logs and boot/migration logs have identical shape
 * while Fastify keeps ownership of the per-request child logger that injects
 * `correlation_id`.
 */
export const loggerOptions: LoggerOptions = {
  level: config.logLevel,
  base: { service: 'paytm-wallet' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: ['req.headers.authorization', 'token', '*.token'],
    censor: '[redacted]',
  },
};

/** For boot, migration and background work, where there is no request in scope. */
export const logger = pino(loggerOptions);

/**
 * The minimum a domain module needs in order to emit events. Both the standalone logger
 * above and Fastify's per-request `request.log` satisfy it, so `executeMovement` can log
 * with the caller's correlation id attached without depending on either concrete type.
 */
export interface EventLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}
