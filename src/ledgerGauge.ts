import { query } from './db.js';
import { logger } from './logger.js';
import { metrics } from './metrics.js';

interface LedgerSnapshot {
  wallet_count: bigint;
  total_paise: bigint;
  min_paise: bigint;
}

/**
 * Publish the conservation invariant as a metric.
 *
 * `ledger_total_balance_paise` is the sum of every wallet balance. Because funding is a
 * transfer out of the pre-seeded mint wallet rather than a faucet, this number is fixed for
 * the entire life of the database -- it should be a dead-flat line on a graph through any
 * amount of load. A step in it means money was created or destroyed.
 *
 * `ledger_min_balance_paise` is the lowest balance in the system and must never be negative.
 *
 * Together they turn the two hardest invariants into something observable at a glance,
 * rather than something you can only discover by running a test.
 */
export function startLedgerGaugeRefresh(intervalMs = 5_000): NodeJS.Timeout {
  const refresh = async (): Promise<void> => {
    try {
      const result = await query<LedgerSnapshot>(
        `SELECT COUNT(*)::bigint                        AS wallet_count,
                COALESCE(SUM(balance_paise), 0)::bigint AS total_paise,
                COALESCE(MIN(balance_paise), 0)::bigint AS min_paise
           FROM wallets`,
      );
      const row = result.rows[0];
      if (row === undefined) return;

      metrics.walletsTotal.set(Number(row.wallet_count));
      metrics.ledgerTotalPaise.set(Number(row.total_paise));
      metrics.ledgerMinPaise.set(Number(row.min_paise));

      if (row.min_paise < 0n) {
        logger.error(
          { event: 'ledger.invariant_violated', invariant: 'no_overdraft', min_paise: row.min_paise.toString(10) },
          'a wallet balance is negative',
        );
      }
    } catch (err) {
      logger.warn({ event: 'ledger.gauge_refresh_failed', err }, 'could not refresh ledger gauges');
    }
  };

  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  timer.unref();
  return timer;
}
