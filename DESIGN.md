# Design & reasoning

## Data model

Three tables (`migrations/001_init.sql`). The invariants are enforced by database
constraints, not by application code that could be bypassed under a race.

**`wallets`**
- `id UUID` PK, `user_id TEXT`, `balance_paise BIGINT`, timestamps.
- `UNIQUE (user_id)` — one wallet per user. This constraint, not a check in the app, is what
  makes get-or-create race-free.
- `CHECK (balance_paise >= 0)` — a negative balance can never be committed. This is the
  backstop; the conditional debit is the primary guard.

**`transfers`**
- `id UUID` PK, `idempotency_key TEXT`, `request_sha256 TEXT`, `from_wallet_id`,
  `to_wallet_id`, `amount_paise BIGINT`, `status` enum
  (`pending | applied | declined_insufficient_funds`), `declined_reason`, `correlation_id`,
  timestamps.
- `UNIQUE (idempotency_key)` — one transfer per key. This is the whole basis of
  exactly-once.
- `request_sha256` is a digest of the canonicalised request (caller, from, to, amount). It
  lets a replay of the *same* request be distinguished from a *different* request reusing
  the key, which must be `409`.
- `CHECK (amount_paise > 0)`, `CHECK (from_wallet_id <> to_wallet_id)`.

**Money is integer paise everywhere.** Storage is `BIGINT`; `pg` is configured to parse
`int8` to JavaScript `bigint`, not `number`, so a balance is never coerced through a float.
The only place paise become a JSON `number` is the HTTP boundary, which asserts the value is
within the safe-integer range first (`src/money.ts`). There is no `NUMERIC` and no float on
the money path.

**The mint wallet.** Wallets have to be funded before transfers can run. Rather than a
faucet that conjures a balance into existence (which would break conservation during
seeding), one pre-seeded "mint" wallet holds a large balance, and funding is an ordinary
transfer out of it through the same primitive as any P2P transfer. So the sum of all
balances is constant from the moment migrations finish — including while a test run seeds
its wallets. The conservation gauge is a flat line for the entire life of the deployment.

## The simplest-correct mechanism for conservation + no-overdraft

Every money movement — P2P transfer, mint funding, and any future reversal — goes through
one function, `executeMovement` (`src/ledger.ts`), inside a single transaction. It does
three things in this order:

1. **Lock both wallet rows `FOR UPDATE`, in ascending wallet-id order.**
2. **Claim the idempotency key** with `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`.
3. **Debit with an atomic conditional `UPDATE`**, then credit:
   ```sql
   UPDATE wallets SET balance_paise = balance_paise - $amount
    WHERE id = $from AND balance_paise >= $amount;   -- 0 rows affected  ->  decline
   ```

The conditional `UPDATE` does the read, the solvency test and the write as one statement
inside the database, so there is no read-modify-write window. Zero rows affected means
insufficient funds, and nothing was written — a clean decline with no partial apply.

**Deadlock avoidance.** Locking in a deterministic order (lowest wallet id first) means
every transfer in the system requests its two locks in the same global order, so A→B and
B→A arriving together queue instead of forming a cycle.

**Why the lock comes *before* the idempotency insert — a bug I hit and fixed.** My first
version claimed the key first, then took the sorted locks. Under the 400-way contention burst
this produced a storm of deadlocks (`40P01`) and statement timeouts (`57014`), failing 398 of
400 requests. The cause: the `transfers` insert has foreign keys to both wallets, so Postgres
takes a `FOR KEY SHARE` lock on each referenced wallet row *during the insert*, in FK-check
order — not my sorted order. Two opposite transfers each ended up holding `KEY SHARE` on both
rows and then deadlocked trying to upgrade to a row-exclusive lock. Moving the sorted
`FOR UPDATE` acquisition ahead of the insert fixed it: the stronger lock is taken in a
consistent order and subsumes the FK lock the insert wants. After the fix the same burst runs
360 applied + 40 declined, zero failures. This is exactly the A→B/B→A case the exercise
probes, and it is why the ordering is load-bearing rather than incidental.

### Heavier alternatives I rejected

- **`SERIALIZABLE` isolation everywhere.** Correct, but it pushes the cost onto
  serialization failures (`40001`) that must be caught and the whole transaction retried,
  and under the A↔B contention burst the retry rate would be high. The conditional `UPDATE`
  gets the same guarantees for this workload with plain `READ COMMITTED` and far less retry
  churn. I kept a retry loop anyway (`withTransaction`) as a backstop for the rare
  deadlock/serialization abort, but it is not the primary mechanism.
- **`SELECT balance … FOR UPDATE`, subtract in the app, write it back.** This is the classic
  lost-update bug: two transfers read the same starting balance and the second write erases
  the first, creating or destroying money. No amount of locking discipline saves it because
  the arithmetic happened outside the database. Rejected outright; it is the single most
  common way this exercise is failed.
- **A separate append-only journal / double-entry ledger table as the source of truth, with
  balances derived by summing.** A great design for audit and for real custody, but heavier
  than this exercise needs: it makes the read path (`GET /wallets/{id}`) a sum over history
  or requires a materialised balance anyway. I kept a materialised `balance_paise` column
  guarded by the conditional update, plus the `transfers` table as the record of movements.

## Where idempotency lives

Uniqueness is enforced by the `transfers.idempotency_key` unique constraint in the database —
never in application memory or a cache, which would not hold across two instances. The key is
claimed with `INSERT ... ON CONFLICT DO NOTHING` **in the same transaction as the debit and
credit**, so the key-burn and the money movement commit or roll back together. There is no
window in which the key is recorded as used but the money did not move, or vice-versa.

Under a concurrent storm of the same key, the insert blocks on the unique index while the
first transaction holds its uncommitted row. When that transaction commits, the others'
insert affects zero rows; they then re-`SELECT` the committed transfer (visible because
`READ COMMITTED` takes a fresh snapshot per statement) and return it. The losers never guess
— they read the winner's committed decision. On a same-key/**different**-body replay, the
stored `request_sha256` differs, so the request is rejected `409` and no second debit occurs.

`READ COMMITTED`, not `REPEATABLE READ`, is required here: the re-`SELECT` after a lost insert
race must see the row the other transaction just committed. `REPEATABLE READ` pins the
snapshot to the transaction's first statement and would not see it, breaking the replay path.

## Consistency vs availability

This is money, so I chose **consistency**. Concretely:

- A single primary Postgres is the linearizable source of truth for balances. Correctness of
  a debit depends on reading the latest committed balance under a row lock, which a stale
  replica cannot provide, so writes are not served from replicas.
- **What I consciously gave up:** availability during a primary outage. If Postgres is down
  the service returns `503` (`/readyz` fails) rather than accepting a transfer it cannot
  durably and consistently apply. For a wallet that is the right trade — a refused transfer is
  recoverable by retry (the idempotency key makes the retry safe); a double-spend or a lost
  debit is not.
- Within the database the transfer is fully ACID. Across the HTTP boundary the client gets
  at-least-once delivery semantics, which the idempotency key upgrades to effectively
  exactly-once: a client that times out can safely retry with the same key.

## AI: directed vs decided

- **Directed (I decided, AI typed):** the concurrency model — sorted-lock-then-conditional-
  update, idempotency committed in the ledger transaction, integer-paise-only with `bigint`
  end to end, funding-as-a-transfer to preserve conservation during seeding, and the
  lock-before-insert ordering fix once the deadlock storm showed up in the load test.
- **Decided by AI, accepted after review:** boilerplate shape — the Fastify wiring, the pino
  log field names, the Prometheus metric names, the burst script's output formatting, and the
  Dockerfile stage layout. I reviewed these; they do not affect the invariants.
- **Verified, not assumed:** every invariant was reproduced by running `scripts/burst.mjs`
  against the containerised service. The deadlock bug above was found by that load test, not
  by inspection, and the fix was re-verified the same way (398 failures → 0).

## Cost

**₹0.** Local development is Docker Compose. The deploy target is Render's free web service +
free managed Postgres (`render.yaml`); the same image runs on Railway / Fly.io / Koyeb free
tiers. No card required, no paid add-ons.

## Known limits / honest notes

- `POST /users` is unauthenticated so the graders can mint their own tokens to run the burst
  against the live URL. Creating a user cannot create money — funding requires the admin
  token. On a service with real custody this would sit behind signup verification and a rate
  limit.
- The free-tier Postgres connection cap is low; `PG_POOL_MAX` is set conservatively (8 on
  Render) to stay under it. Under a very large burst the app queues requests for a pool
  connection rather than exhausting the database.
- Auth is a per-user opaque bearer token stored as a SHA-256 digest — deliberately minimal,
  since the brief states auth sophistication is not graded.
