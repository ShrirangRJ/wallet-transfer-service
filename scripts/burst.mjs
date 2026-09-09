#!/usr/bin/env node
/**
 * One-command burst script. Reproduces every invariant in the brief against a running
 * instance, local or deployed, and exits non-zero if any of them fails.
 *
 *   node scripts/burst.mjs                                   # http://localhost:8080
 *   node scripts/burst.mjs --url https://your-app.onrender.com --admin-token <token>
 *
 * Zero dependencies: Node 22's global fetch and node:util parseArgs only.
 *
 * Every request carries an X-Correlation-Id of the form
 *
 *     burst-<runId>-<gate>-<n>
 *
 * so any assertion below can be traced straight into the service logs. The run id is
 * printed at the top and again in the summary.
 */

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.BASE_URL ?? 'http://localhost:8080' },
    'admin-token': {
      type: 'string',
      default: process.env.ADMIN_TOKEN ?? 'dev-admin-token-change-me',
    },
    'gate1-n': { type: 'string', default: '50' },
    'gate2-k': { type: 'string', default: '30' },
    'gate3-wallets': { type: 'string', default: '6' },
    'gate3-transfers': { type: 'string', default: '400' },
    'skip-metrics-check': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(
    [
      'Usage: node scripts/burst.mjs [options]',
      '',
      '  --url <url>                base URL of the service (default http://localhost:8080)',
      '  --admin-token <token>      token for the admin funding endpoint',
      '  --gate1-n <n>              concurrent POST /wallets calls        (default 50)',
      '  --gate2-k <k>              concurrent identical transfers        (default 30)',
      '  --gate3-wallets <n>        wallets in the contention set         (default 6)',
      '  --gate3-transfers <n>      concurrent transfers under contention (default 400)',
      '  --skip-metrics-check       skip the /metrics conservation gauge check',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const BASE = values.url.replace(/\/+$/, '');
const ADMIN_TOKEN = values['admin-token'];
const GATE1_N = Number.parseInt(values['gate1-n'], 10);
const GATE2_K = Number.parseInt(values['gate2-k'], 10);
const GATE3_WALLETS = Number.parseInt(values['gate3-wallets'], 10);
const GATE3_TRANSFERS = Number.parseInt(values['gate3-transfers'], 10);
const RUN_ID = randomUUID().slice(0, 8);

// ---------------------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------------------

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code, text) => (useColor ? `\u001B[${code}m${text}\u001B[0m` : text);
const bold = (t) => paint('1', t);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);
const dim = (t) => paint('2', t);

const say = (line = '') => process.stdout.write(`${line}\n`);
const detail = (line) => say(`    ${dim(line)}`);

/** @type {{ gate: string, name: string, ok: boolean, note: string }[]} */
const results = [];

function check(gate, name, ok, note = '') {
  results.push({ gate, name, ok, note });
  say(`  ${ok ? green('PASS') : red('FAIL')}  ${name}${note === '' ? '' : dim(`  (${note})`)}`);
}

function heading(text) {
  say();
  say(bold(text));
}

// ---------------------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------------------

/**
 * @param {string} method
 * @param {string} path
 * @param {{ token?: string, body?: unknown, correlationId?: string }} [opts]
 */
async function call(method, path, opts = {}) {
  const headers = { accept: 'application/json' };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.correlationId !== undefined) headers['x-correlation-id'] = opts.correlationId;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const text = await response.text();
  let body;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 400) };
  }

  return {
    status: response.status,
    replay: response.headers.get('x-idempotent-replay'),
    correlationId: response.headers.get('x-correlation-id'),
    body,
  };
}

function fatal(message, extra) {
  say();
  say(red(`setup failed: ${message}`));
  if (extra !== undefined) say(dim(JSON.stringify(extra, null, 2)));
  process.exit(2);
}

// ---------------------------------------------------------------------------------------
// setup helpers
// ---------------------------------------------------------------------------------------

async function createUser(label) {
  const userId = `burst_${RUN_ID}_${label}`;
  const res = await call('POST', '/users', {
    body: { user_id: userId },
    correlationId: `burst-${RUN_ID}-setup-user-${label}`,
  });
  if (res.status !== 201) fatal(`could not create user ${userId}`, res);
  return { userId, token: res.body.token };
}

async function createWallet(token, label) {
  const res = await call('POST', '/wallets', {
    token,
    correlationId: `burst-${RUN_ID}-setup-wallet-${label}`,
  });
  if (res.status !== 201 && res.status !== 200) fatal('could not create wallet', res);
  return res.body.wallet_id;
}

async function fund(walletId, amountPaise, label) {
  const res = await call('POST', `/wallets/${walletId}/fund`, {
    token: ADMIN_TOKEN,
    body: { amount_paise: amountPaise, idempotency_key: `burst-${RUN_ID}-fund-${label}` },
    correlationId: `burst-${RUN_ID}-setup-fund-${label}`,
  });
  if (res.status !== 201) {
    fatal(
      `could not fund wallet ${walletId}; is --admin-token correct?`,
      res,
    );
  }
}

async function balance(walletId) {
  const res = await call('GET', `/wallets/${walletId}`, {
    token: ADMIN_TOKEN,
    correlationId: `burst-${RUN_ID}-balance-${walletId.slice(0, 8)}`,
  });
  if (res.status !== 200) fatal(`could not read balance of ${walletId}`, res);
  return BigInt(res.body.balance_paise);
}

async function sumBalances(walletIds) {
  const values = await Promise.all(walletIds.map(balance));
  return values.reduce((total, value) => total + value, 0n);
}

const countBy = (items, fn) => {
  const counts = new Map();
  for (const item of items) {
    const key = fn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const statusHistogram = (responses) =>
  [...countBy(responses, (r) => r.status).entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([status, n]) => `${status}x${n}`)
    .join(' ');

/** Fire every request at once, then wait. Rejections become status 0 so nothing is hidden. */
async function fireAll(tasks) {
  const settled = await Promise.allSettled(tasks.map((task) => task()));
  return settled.map((outcome) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : { status: 0, body: { error: { message: String(outcome.reason) } }, replay: null },
  );
}

async function readGauge(name) {
  const res = await fetch(`${BASE}/metrics`);
  const text = await res.text();
  const line = text
    .split('\n')
    .find((candidate) => candidate.startsWith(`${name}{`) || candidate.startsWith(`${name} `));
  if (line === undefined) return undefined;
  const value = Number.parseFloat(line.slice(line.lastIndexOf(' ') + 1));
  return Number.isFinite(value) ? value : undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------
// gate 1 -- race-free get-or-create
// ---------------------------------------------------------------------------------------

async function gate1() {
  heading(`Gate 1 — race-free get-or-create (${GATE1_N} concurrent POST /wallets, fresh user)`);

  const user = await createUser('g1');

  const responses = await fireAll(
    Array.from({ length: GATE1_N }, (_unused, i) => () =>
      call('POST', '/wallets', {
        token: user.token,
        correlationId: `burst-${RUN_ID}-g1-${i}`,
      }),
    ),
  );

  const walletIds = new Set(
    responses.filter((r) => r.status === 200 || r.status === 201).map((r) => r.body?.wallet_id),
  );
  const created = responses.filter((r) => r.status === 201).length;
  const serverErrors = responses.filter((r) => r.status >= 500 || r.status === 0).length;

  detail(`statuses: ${statusHistogram(responses)}`);
  detail(`distinct wallet ids returned: ${walletIds.size}`);

  check('1', 'exactly one wallet exists for the user', walletIds.size === 1, `${walletIds.size} distinct id(s)`);
  check('1', 'exactly one request reports having created it', created === 1, `${created} x 201`);
  check('1', 'no 5xx / transport errors under the storm', serverErrors === 0, `${serverErrors} failures`);
}

// ---------------------------------------------------------------------------------------
// gate 2 -- idempotent exactly-once transfer
// ---------------------------------------------------------------------------------------

async function gate2() {
  heading(`Gate 2 — idempotent retry storm (${GATE2_K} concurrent transfers, one key)`);

  const alice = await createUser('g2a');
  const bob = await createUser('g2b');
  const aliceWallet = await createWallet(alice.token, 'g2a');
  const bobWallet = await createWallet(bob.token, 'g2b');
  await fund(aliceWallet, 100_000, 'g2a');

  const before = { alice: await balance(aliceWallet), bob: await balance(bobWallet) };
  const amount = 25_000;
  const key = `burst-${RUN_ID}-g2-once`;
  const body = { from: aliceWallet, to: bobWallet, amount_paise: amount, idempotency_key: key };

  const responses = await fireAll(
    Array.from({ length: GATE2_K }, (_unused, i) => () =>
      call('POST', '/transfers', {
        token: alice.token,
        body,
        correlationId: `burst-${RUN_ID}-g2-${i}`,
      }),
    ),
  );

  const accepted = responses.filter((r) => r.status === 200 || r.status === 201);
  const transferIds = new Set(accepted.map((r) => r.body?.transfer_id));
  const applied = responses.filter((r) => r.status === 201).length;
  const replays = responses.filter((r) => r.replay === 'true').length;
  const serverErrors = responses.filter((r) => r.status >= 500 || r.status === 0).length;
  const distinctBodies = new Set(accepted.map((r) => JSON.stringify(r.body)));

  const after = { alice: await balance(aliceWallet), bob: await balance(bobWallet) };
  const debited = before.alice - after.alice;
  const credited = after.bob - before.bob;

  detail(`statuses: ${statusHistogram(responses)}`);
  detail(`debited ${debited} paise, credited ${credited} paise, amount was ${amount}`);
  detail(`X-Idempotent-Replay: true on ${replays} of ${GATE2_K} responses`);

  check('2', 'exactly one transfer id across all responses', transferIds.size === 1, `${transferIds.size} distinct`);
  check('2', 'exactly one request applied it', applied === 1, `${applied} x 201`);
  check('2', 'every accepted response body is identical', distinctBodies.size === 1, `${distinctBodies.size} distinct bodies`);
  check('2', 'sender debited exactly once', debited === BigInt(amount), `${debited} paise`);
  check('2', 'recipient credited exactly once', credited === BigInt(amount), `${credited} paise`);
  check('2', 'no 5xx / transport errors under the storm', serverErrors === 0, `${serverErrors} failures`);

  // GET /transfers/{id} must agree with the burst responses.
  const transferId = [...transferIds][0];
  const fetched = await call('GET', `/transfers/${transferId}`, {
    token: alice.token,
    correlationId: `burst-${RUN_ID}-g2-get`,
  });
  check(
    '2',
    'GET /transfers/{id} reports it applied',
    fetched.status === 200 && fetched.body?.status === 'applied',
    `status ${fetched.status}, transfer status ${fetched.body?.status}`,
  );

  // Same key, different body -> 409, and no second debit.
  const conflict = await call('POST', '/transfers', {
    token: alice.token,
    body: { ...body, amount_paise: amount + 1 },
    correlationId: `burst-${RUN_ID}-g2-conflict`,
  });
  const afterConflict = await balance(aliceWallet);

  detail(`same key + different amount -> ${conflict.status} ${conflict.body?.error?.code ?? ''}`);

  check('2', 'reused key with a different body is 409', conflict.status === 409, `got ${conflict.status}`);
  check('2', 'the 409 moved no money', afterConflict === after.alice, `${afterConflict} paise`);
}

// ---------------------------------------------------------------------------------------
// gate 3 -- conservation + no overdraft under contention
// ---------------------------------------------------------------------------------------

async function gate3() {
  heading(
    `Gate 3 — conservation under contention (${GATE3_TRANSFERS} concurrent transfers over ${GATE3_WALLETS} wallets)`,
  );

  const seedPerWallet = 100_000;
  const participants = [];
  for (let i = 0; i < GATE3_WALLETS; i += 1) {
    const user = await createUser(`g3_${i}`);
    const walletId = await createWallet(user.token, `g3_${i}`);
    await fund(walletId, seedPerWallet, `g3_${i}`);
    participants.push({ ...user, walletId });
  }

  const totalBefore = await sumBalances(participants.map((p) => p.walletId));
  detail(`seeded total: ${totalBefore} paise across ${participants.length} wallets`);

  /** @type {{ from: number, to: number, amount: number, kind: string }[]} */
  const plan = [];

  // The deadlock probe. A->B and B->A on the same pair, adjacent in the plan so they are
  // in flight simultaneously. An implementation that locks rows in request order rather
  // than a deterministic order deadlocks here and starts returning 500s.
  const crossPairs = [
    [0, 1],
    [2, 3],
    [0, 2],
  ];
  const crossRounds = Math.floor(GATE3_TRANSFERS * 0.3 / (crossPairs.length * 2));
  for (let round = 0; round < crossRounds; round += 1) {
    for (const [a, b] of crossPairs) {
      if (a >= participants.length || b >= participants.length) continue;
      plan.push({ from: a, to: b, amount: 1_000 + (round % 7) * 100, kind: 'cross' });
      plan.push({ from: b, to: a, amount: 1_000 + (round % 5) * 100, kind: 'cross' });
    }
  }

  // Deliberate overdrafts: more than any single wallet was seeded with. These must be
  // declined cleanly, with no partial apply.
  const overdraftCount = Math.max(5, Math.floor(GATE3_TRANSFERS * 0.1));
  for (let i = 0; i < overdraftCount; i += 1) {
    const from = i % participants.length;
    const to = (from + 1) % participants.length;
    plan.push({ from, to, amount: seedPerWallet * 3, kind: 'overdraft' });
  }

  // Fill the rest with random traffic across the whole set.
  while (plan.length < GATE3_TRANSFERS) {
    const from = Math.floor(Math.random() * participants.length);
    let to = Math.floor(Math.random() * participants.length);
    if (to === from) to = (from + 1) % participants.length;
    plan.push({ from, to, amount: 1 + Math.floor(Math.random() * 5_000), kind: 'random' });
  }

  const responses = await fireAll(
    plan.map((op, i) => () =>
      call('POST', '/transfers', {
        token: participants[op.from].token,
        body: {
          from: participants[op.from].walletId,
          to: participants[op.to].walletId,
          amount_paise: op.amount,
          idempotency_key: `burst-${RUN_ID}-g3-${i}`,
        },
        correlationId: `burst-${RUN_ID}-g3-${op.kind}-${i}`,
      }),
    ),
  );

  const totalAfter = await sumBalances(participants.map((p) => p.walletId));
  const balances = await Promise.all(participants.map((p) => balance(p.walletId)));
  const minBalance = balances.reduce((low, value) => (value < low ? value : low), balances[0]);

  const appliedCount = responses.filter((r) => r.status === 201).length;
  const declinedCount = responses.filter((r) => r.status === 422).length;
  const serverErrors = responses.filter((r) => r.status >= 500 || r.status === 0).length;
  const otherStatuses = responses.filter(
    (r) => ![201, 422].includes(r.status) && r.status < 500 && r.status !== 0,
  );

  detail(`statuses: ${statusHistogram(responses)}`);
  detail(`applied ${appliedCount}, declined-insufficient-funds ${declinedCount}`);
  detail(`total before ${totalBefore} paise, total after ${totalAfter} paise`);
  detail(`lowest balance after: ${minBalance} paise`);

  check('3', 'total balance unchanged (money conserved)', totalAfter === totalBefore, `${totalAfter - totalBefore} paise drift`);
  check('3', 'no negative balance', minBalance >= 0n, `min ${minBalance} paise`);
  check('3', 'no 5xx / transport errors under contention', serverErrors === 0, `${serverErrors} failures`);
  check('3', 'the overdraft path was actually exercised', declinedCount > 0, `${declinedCount} declined`);
  check('3', 'no unexpected status codes', otherStatuses.length === 0, statusHistogram(otherStatuses) || 'none');

  if (declinedCount > 0) {
    const sample = responses.find((r) => r.status === 422);
    detail(`sample decline: ${JSON.stringify(sample.body)}`);
  }
}

// ---------------------------------------------------------------------------------------
// observability -- conservation as a metric
// ---------------------------------------------------------------------------------------

async function metricsCheck(before) {
  heading('Observability — conservation gauge and domain counters at /metrics');

  if (before === undefined) {
    check('4', 'ledger_total_balance_paise is exported', false, 'gauge not found at /metrics');
    return;
  }

  // The gauge is refreshed on a 5s interval, so give it a cycle to pick up everything the
  // burst just did.
  await sleep(6_000);
  const after = await readGauge('ledger_total_balance_paise');
  const minGauge = await readGauge('ledger_min_balance_paise');

  detail(`ledger_total_balance_paise: ${before} -> ${after}`);
  detail(`ledger_min_balance_paise: ${minGauge}`);

  check(
    '4',
    'global conservation gauge unchanged across the whole run',
    after === before,
    `drift ${after === undefined ? 'unknown' : after - before} paise`,
  );
  check('4', 'no wallet in the system is negative', minGauge !== undefined && minGauge >= 0, `min ${minGauge}`);

  const res = await fetch(`${BASE}/metrics`);
  const text = await res.text();
  for (const name of [
    'transfers_created_total',
    'transfers_declined_total',
    'transfers_idempotent_replays_total',
    'transfers_idempotency_conflicts_total',
    'wallets_created_total',
  ]) {
    const line = text.split('\n').find((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `));
    detail(line === undefined ? `${name}: MISSING` : line.trim());
  }

  const p99 = text
    .split('\n')
    .filter((l) => l.includes('quantile="0.99"') && l.includes('/transfers'))
    .map((l) => l.trim());
  if (p99.length > 0) {
    say();
    detail('POST /transfers p99 latency (seconds):');
    for (const line of p99.slice(0, 4)) detail(`  ${line}`);
  }
}

// ---------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------

async function main() {
  say(bold(`paytm-wallet burst  ->  ${BASE}`));
  say(dim(`run id ${RUN_ID}  (grep the logs for "burst-${RUN_ID}")`));

  const root = await call('GET', '/healthz');
  if (root.status !== 200) {
    fatal(`service is not healthy at ${BASE}/healthz`, root);
  }

  if (!BASE.includes('localhost') && ADMIN_TOKEN === 'dev-admin-token-change-me') {
    say(yellow('  warning: using the default admin token against a remote URL; pass --admin-token'));
  }

  const gaugeBefore = values['skip-metrics-check']
    ? undefined
    : await readGauge('ledger_total_balance_paise');

  await gate1();
  await gate2();
  await gate3();
  if (!values['skip-metrics-check']) await metricsCheck(gaugeBefore);

  const failed = results.filter((r) => !r.ok);
  say();
  say(bold('summary'));
  say(`  checks: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  say(dim(`  run id: ${RUN_ID}`));

  if (failed.length > 0) {
    say();
    say(red('failed checks:'));
    for (const failure of failed) {
      say(red(`  gate ${failure.gate}: ${failure.name}${failure.note === '' ? '' : ` (${failure.note})`}`));
    }
    say();
    process.exit(1);
  }

  say();
  say(green('all invariants hold'));
}

await main();
