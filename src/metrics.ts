import { Counter, Gauge, Histogram, Registry, Summary, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'paytm-wallet' });
collectDefaultMetrics({ register: registry });

/**
 * Two latency instruments on purpose:
 *
 *  - the Histogram is what a real Prometheus scrape wants (buckets, so p99 can be
 *    computed across instances with histogram_quantile);
 *  - the Summary emits an already-computed p50/p90/p99 in the exposition text, so the
 *    number is readable straight off `GET /metrics` without standing up a Prometheus.
 *
 * Alongside those, the counters below are the domain signals -- transfers created,
 * declined for insufficient funds, idempotent replays served, key conflicts rejected.
 * Those are the lines that tell you what the ledger did, which request-rate and latency
 * cannot.
 */
export const metrics = {
  httpRequests: new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by method, route and status code',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  }),

  httpDuration: new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),

  httpDurationSummary: new Summary({
    name: 'http_request_duration_summary_seconds',
    help: 'HTTP request latency percentiles (p50/p90/p99) computed in-process',
    labelNames: ['method', 'route'] as const,
    percentiles: [0.5, 0.9, 0.99],
    maxAgeSeconds: 600,
    ageBuckets: 5,
    registers: [registry],
  }),

  walletsCreated: new Counter({
    name: 'wallets_created_total',
    help: 'Wallets actually inserted by get-or-create',
    registers: [registry],
  }),

  walletGetOrCreateConflicts: new Counter({
    name: 'wallet_get_or_create_conflicts_total',
    help: 'get-or-create calls whose INSERT lost the race on wallets_user_id_uniq and returned the existing wallet',
    registers: [registry],
  }),

  transfersCreated: new Counter({
    name: 'transfers_created_total',
    help: 'Transfers applied (one debit + one credit committed)',
    labelNames: ['kind'] as const,
    registers: [registry],
  }),

  transfersDeclined: new Counter({
    name: 'transfers_declined_total',
    help: 'Transfers declined without applying any balance change',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),

  idempotentReplays: new Counter({
    name: 'transfers_idempotent_replays_total',
    help: 'Requests that presented an already-used idempotency key with a matching body and were served the original result',
    labelNames: ['status'] as const,
    registers: [registry],
  }),

  idempotencyConflicts: new Counter({
    name: 'transfers_idempotency_conflicts_total',
    help: 'Requests rejected with 409 because the idempotency key was reused with a different body',
    registers: [registry],
  }),

  txRetries: new Counter({
    name: 'db_tx_retries_total',
    help: 'Transactions retried after Postgres aborted them (deadlock or serialization failure)',
    labelNames: ['label', 'code'] as const,
    registers: [registry],
  }),

  /**
   * Conservation, exported as a gauge. The sum of every wallet balance must be a flat line
   * for the entire life of the deployment -- funding is a transfer out of the mint wallet,
   * so even seeding does not move it. If this gauge ever steps, money was created or
   * destroyed, and that is visible on a graph without running a single test.
   */
  ledgerTotalPaise: new Gauge({
    name: 'ledger_total_balance_paise',
    help: 'Sum of all wallet balances in paise; must never change',
    registers: [registry],
  }),

  ledgerMinPaise: new Gauge({
    name: 'ledger_min_balance_paise',
    help: 'Lowest wallet balance in paise; must never go below zero',
    registers: [registry],
  }),

  walletsTotal: new Gauge({
    name: 'wallets_total',
    help: 'Number of wallet rows',
    registers: [registry],
  }),
} as const;
