-- 001_init.sql
--
-- Design notes that matter for correctness (see DESIGN.md for the full reasoning):
--
--   * Money is BIGINT paise. There is no NUMERIC and no floating point anywhere in the
--     money path. Every arithmetic operation on a balance happens inside the database.
--   * wallets.user_id carries a UNIQUE constraint. That constraint -- not application
--     logic -- is what makes get-or-create race-free.
--   * transfers.idempotency_key carries a UNIQUE constraint. That constraint -- not an
--     application-level "does it already exist?" check -- is what makes a transfer
--     exactly-once. The claim on the key and the balance movement are committed in the
--     same transaction.
--   * wallets.balance_paise carries CHECK (balance_paise >= 0). The conditional debit in
--     the application is the primary no-overdraft guard; this CHECK is the backstop that
--     turns any future logic regression into an aborted transaction rather than a
--     negative balance.

CREATE TABLE IF NOT EXISTS users (
    id           TEXT        PRIMARY KEY,
    token_sha256 TEXT        NOT NULL,
    is_admin     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_token_sha256_uniq UNIQUE (token_sha256)
);

CREATE TABLE IF NOT EXISTS wallets (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       TEXT        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    balance_paise BIGINT      NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Gate 1: one wallet per user, enforced by the database.
    CONSTRAINT wallets_user_id_uniq UNIQUE (user_id),

    -- Gate 3 backstop: a negative balance can never be committed.
    CONSTRAINT wallets_balance_non_negative CHECK (balance_paise >= 0)
);

DO $$
BEGIN
    CREATE TYPE transfer_status AS ENUM ('pending', 'applied', 'declined_insufficient_funds');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS transfers (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT            NOT NULL,

    -- sha256 of the canonicalised semantic request (caller, from, to, amount). Lets us
    -- distinguish "the client retried the same request" from "the client reused a key
    -- with a different body", which must be a 409 rather than a second debit.
    request_sha256  TEXT            NOT NULL,

    from_wallet_id  UUID            NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
    to_wallet_id    UUID            NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
    amount_paise    BIGINT          NOT NULL,
    status          transfer_status NOT NULL DEFAULT 'pending',
    declined_reason TEXT,
    correlation_id  TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    settled_at      TIMESTAMPTZ,

    -- Gate 2: one transfer per idempotency key, enforced by the database.
    CONSTRAINT transfers_idempotency_key_uniq UNIQUE (idempotency_key),
    CONSTRAINT transfers_amount_positive      CHECK (amount_paise > 0),
    CONSTRAINT transfers_distinct_wallets     CHECK (from_wallet_id <> to_wallet_id),
    CONSTRAINT transfers_settled_consistently CHECK (
        (status = 'pending' AND settled_at IS NULL)
        OR (status <> 'pending' AND settled_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS transfers_from_wallet_idx ON transfers (from_wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_to_wallet_idx   ON transfers (to_wallet_id, created_at DESC);

-- The mint wallet.
--
-- Wallets have to be funded from somewhere before a transfer burst can be run. Rather
-- than a faucet that conjures money into a balance (which would break conservation while
-- seeding), funding is an ordinary transfer out of this one pre-seeded wallet, using the
-- exact same ledger primitive as any peer-to-peer transfer. The sum of all balances is
-- therefore constant from the moment migrations finish -- including during setup.
--
-- The mint's token hash is a non-hash sentinel, so no bearer token can ever authenticate
-- as this user.
INSERT INTO users (id, token_sha256, is_admin)
VALUES ('system', 'no-token:system-mint', FALSE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallets (id, user_id, balance_paise)
VALUES ('00000000-0000-0000-0000-000000000001', 'system', 100000000000000)
ON CONFLICT (user_id) DO NOTHING;
