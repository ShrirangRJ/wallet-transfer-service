import { closePool } from './db.js';
import { config } from './config.js';
import { startLedgerGaugeRefresh } from './ledgerGauge.js';
import { logger } from './logger.js';
import { runMigrations } from './migrate.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  logger.info(
    { event: 'boot.start', node_env: config.nodeEnv, node_version: process.version },
    'starting paytm-wallet',
  );

  // Migrations run before the listener opens, so a container that is accepting traffic is a
  // container whose schema is current. This is also what makes `docker compose up` and a
  // fresh cloud deploy work with no manual migration step.
  await runMigrations();

  startLedgerGaugeRefresh();

  const app = buildServer();
  await app.listen({ port: config.port, host: config.host });
  logger.info({ event: 'boot.ready', port: config.port }, 'listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'shutdown.start', signal }, 'shutting down');
    try {
      // Drain in-flight requests first, then close the pool. Closing the pool first would
      // abort transactions that are mid-transfer.
      await app.close();
      await closePool();
      logger.info({ event: 'shutdown.complete' }, 'shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ event: 'shutdown.failed', err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ event: 'process.unhandled_rejection', err: reason }, 'unhandled rejection');
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ event: 'boot.failed', err }, 'failed to start');
  process.exit(1);
});
