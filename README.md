# Paytm PML R2 — Wallet & P2P Transfer

A small wallet service with peer-to-peer transfers. Money is integer paise, transfers are
exactly-once, and the sum of all balances never changes — under concurrency and failure.

The design write-up (data model, the simplest-correct mechanism, rejected alternatives,
idempotency placement, consistency-vs-availability, AI disclosure, cost) is in
[DESIGN.md](./DESIGN.md).

 **Live URL:** https://paytm-wallet-uy4u.onrender.com
- **Health:** https://paytm-wallet-uy4u.onrender.com/healthz
- **Metrics:** https://paytm-wallet-uy4u.onrender.com/metrics
- **Public logs:** Render dashboard → the `paytm-wallet` service → Logs (structured JSON, one line per request with `correlation_id`)

---

## Run it locally (one command)

```bash
docker compose up --build
```

That brings up Postgres and the app, applies migrations at boot, and serves the API. From a
fresh clone there is no other step.

By default the API is published on host port **8090** and Postgres on host **5433**, chosen
so they do not collide with a Postgres already on 5432 or another service on 8080. Override
either if needed:

```bash
HOST_APP_PORT=9000 HOST_PG_PORT=5544 docker compose up --build
```

Then, in another terminal:

```bash
node scripts/burst.mjs --url http://localhost:8090
```

The burst script reproduces every invariant and prints PASS/FAIL per check, exiting non-zero
if any fails.

---

## API

Money is always **integer paise**. `amount_paise` accepts a JSON integer or an integer
string; decimals, floats and exponent notation are rejected.

| Method | Path                    | Auth        | Purpose |
|--------|-------------------------|-------------|---------|
| POST   | `/users`                | none        | create a user, returns a bearer token |
| POST   | `/wallets`              | user token  | get-or-create the caller's wallet (race-free) |
| GET    | `/wallets/{id}`         | user token  | balance |
| POST   | `/transfers`            | user token  | move money; body: `from`, `to`, `amount_paise`, `idempotency_key` |
| GET    | `/transfers/{id}`       | user token  | transfer status |
| POST   | `/wallets/{id}/fund`    | admin token | fund a wallet from the mint (a normal transfer, not a faucet) |
| GET    | `/healthz`              | none        | liveness |
| GET    | `/readyz`               | none        | readiness (includes a DB round trip) |
| GET    | `/metrics`              | none        | Prometheus exposition + domain counters |

### Response codes on `POST /transfers`

| Status | Meaning |
|--------|---------|
| `201`  | applied by this request (`X-Idempotent-Replay: false`) |
| `200`  | idempotent replay of an already-applied transfer (`X-Idempotent-Replay: true`) |
| `422`  | declined for insufficient funds (a committed decision; replaying the key returns the same 422) |
| `409`  | the `idempotency_key` was reused with a **different** body; nothing applied |

A replay returns a **byte-identical** body to the original; whether it was the applying
request or a replay is carried in the `X-Idempotent-Replay` header and the status code.

### A quick walk-through by hand

```bash
BASE=http://localhost:8090

# Create two users, capture their tokens.
ALICE=$(curl -s -XPOST $BASE/users -H 'content-type: application/json' -d '{"user_id":"alice"}' | jq -r .token)
BOB=$(curl   -s -XPOST $BASE/users -H 'content-type: application/json' -d '{"user_id":"bob"}'   | jq -r .token)

# Create their wallets.
AW=$(curl -s -XPOST $BASE/wallets -H "authorization: Bearer $ALICE" | jq -r .wallet_id)
BW=$(curl -s -XPOST $BASE/wallets -H "authorization: Bearer $BOB"   | jq -r .wallet_id)

# Fund Alice from the mint (admin token; default dev value shown).
curl -s -XPOST $BASE/wallets/$AW/fund \
  -H 'authorization: Bearer dev-admin-token-change-me' \
  -H 'content-type: application/json' \
  -d '{"amount_paise":100000,"idempotency_key":"seed-alice-1"}'

# Alice pays Bob 250.00 rupees = 25000 paise.
curl -s -XPOST $BASE/transfers \
  -H "authorization: Bearer $ALICE" \
  -H 'content-type: application/json' \
  -d "{\"from\":\"$AW\",\"to\":\"$BW\",\"amount_paise\":25000,\"idempotency_key\":\"pay-bob-1\"}"

# Re-send the exact same request: same result, no second debit.
```

---

## What the burst script probes

`scripts/burst.mjs` (zero dependencies, Node 22) reproduces the three graded invariants and
checks observability. Every request carries `X-Correlation-Id: burst-‹runId›-‹gate›-‹n›`, so
each assertion can be traced straight into the logs.

```bash
node scripts/burst.mjs --url http://localhost:8090
# against the deployed service:
node scripts/burst.mjs --url https://your-app.onrender.com --admin-token <ADMIN_TOKEN>
```

- **Gate 1 — race-free get-or-create:** 50 concurrent `POST /wallets` for a fresh user →
  exactly one wallet.
- **Gate 2 — idempotent retry storm:** 30 concurrent identical transfers → one debit, one
  credit, identical bodies; plus a same-key/different-body check expecting `409`.
- **Gate 3 — conservation under contention:** 400 concurrent transfers over a few wallets,
  including A→B and B→A at once and deliberate overdrafts → total unchanged, nothing
  negative, overdrafts declined cleanly, no 5xx.
- **Observability:** the `ledger_total_balance_paise` gauge is unchanged across the whole
  run, and the domain counters are present.

Flags: `--gate1-n`, `--gate2-k`, `--gate3-wallets`, `--gate3-transfers`, `--admin-token`,
`--skip-metrics-check`.

---

## Observability

**Logs** are structured JSON on stdout, one object per line, each request-scoped line
carrying `correlation_id`. Domain events are logged by name: `transfer.created`,
`transfer.debited`, `transfer.credited`, `transfer.applied`, `transfer.declined`,
`transfer.idempotent_replay`, `transfer.idempotency_conflict`, `wallet.created`.

```bash
docker compose logs -f app
```

**Metrics** at `/metrics` include request rate, latency (a histogram plus an in-process
p50/p90/p99 summary) and error rate, and the domain counters:

- `transfers_created_total`, `transfers_declined_total{reason}`,
  `transfers_idempotent_replays_total`, `transfers_idempotency_conflicts_total`,
  `wallets_created_total`
- `ledger_total_balance_paise` — the conservation invariant as a gauge; it must be a flat
  line for the life of the deployment. `ledger_min_balance_paise` must never go below zero.

---

## Deploy (free tier, ₹0)

A [`render.yaml`](./render.yaml) Blueprint deploys the Docker image as a web service backed
by a free managed Postgres. Push the repo to GitHub, then in Render choose **New → Blueprint**
and point it at the repo. The app runs its own migrations at boot, so there is no separate
migration step. Read the generated `ADMIN_TOKEN` from the service's Environment tab to run
the burst script against the live URL.

The same image runs unchanged on Railway, Fly.io or Koyeb; set `DATABASE_URL`,
`DATABASE_SSL=true`, and `ADMIN_TOKEN`.

---

## Layout

```
migrations/001_init.sql   schema; the UNIQUE and CHECK constraints that enforce the invariants
src/ledger.ts             the money-movement primitive (the correctness core)
src/routes.ts             HTTP surface
src/db.ts                 pool, BigInt paise parsing, READ COMMITTED tx with deadlock retry
src/server.ts             Fastify wiring, correlation id, request logging, metrics
src/metrics.ts            Prometheus registry and domain counters
scripts/burst.mjs         one-command invariant reproduction
Dockerfile                multi-stage, non-root, healthcheck
docker-compose.yml        app + Postgres, one-command up
render.yaml               free-tier deploy blueprint
```
