import { createHash } from 'node:crypto';
import { PgErrorCode, pgConstraint, pgErrorCode, pool, type Tx } from './db.js';
import { ApiError } from './errors.js';
import type { EventLogger } from './logger.js';

export type TransferStatus = 'pending' | 'applied' | 'declined_insufficient_funds';

export interface TransferRow {
  id: string;
  idempotency_key: string;
  request_sha256: string;
  from_wallet_id: string;
  to_wallet_id: string;
  amount_paise: bigint;
  status: TransferStatus;
  declined_reason: string | null;
  correlation_id: string | null;
  created_at: Date;
  settled_at: Date | null;
}

const TRANSFER_COLUMNS = `
  id, idempotency_key, request_sha256, from_wallet_id, to_wallet_id,
  amount_paise, status, declined_reason, correlation_id, created_at, settled_at
`;

export interface MovementInput {
  fromWalletId: string;
  toWalletId: string;
  amountPaise: bigint;
  idempotencyKey: string;
  requestSha256: string;
  correlationId: string;
}

export type MovementOutcome =
  /** One debit and one credit were committed by *this* request. */
  | { kind: 'applied'; transfer: TransferRow; replay: false }
  /** The debit was refused; no balance changed. Committed as a durable decision. */
  | { kind: 'declined'; transfer: TransferRow; replay: false }
  /** This key was already used with this exact body; returning the original decision. */
  | { kind: 'replay'; transfer: TransferRow; replay: true }
  /** This key was already used with a *different* body. Nothing applied. */
  | { kind: 'key_conflict'; existing: TransferRow }
  /** Should be unreachable; see the comment at the call site. */
  | { kind: 'in_progress'; existing: TransferRow };

/**
 * Fingerprint of the semantic content of a transfer request.
 *
 * A retry of the same request must replay; the same key carrying a *different* request must
 * be a 409 rather than a second debit. Comparing a digest of the canonicalised fields is
 * how those two cases are told apart. The caller is part of the fingerprint, so one user
 * cannot quietly ride another user's key.
 */
export function requestFingerprint(input: {
  callerUserId: string;
  fromWalletId: string;
  toWalletId: string;
  amountPaise: bigint;
}): string {
  const canonical = [
    'v1',
    input.callerUserId,
    input.fromWalletId,
    input.toWalletId,
    input.amountPaise.toString(10),
  ].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Move `amountPaise` from one wallet to another, exactly once, inside the caller's
 * transaction.
 *
 * This is the *only* function in the codebase that changes a balance. Every money movement
 * -- peer-to-peer transfer, mint funding, and any future reversal or refund -- goes through
 * it, so the invariants are proved once rather than per feature.
 *
 * ---------------------------------------------------------------------------------------
 * Step 1 -- take both row locks first, in a deterministic order.
 *
 *   A transfer touches two rows, so it holds two row locks. If A->B locks A then B while
 *   B->A locks B then A, they deadlock, and Postgres kills one with 40P01. Sorting the two
 *   wallet ids and locking the lower one first means every concurrent transfer requests
 *   these locks in the same global order, which makes a lock cycle impossible.
 *
 *   This is done BEFORE the idempotency INSERT, and the ordering is load-bearing. The INSERT
 *   carries foreign keys to both wallets, so it would otherwise take a weaker FOR KEY SHARE
 *   lock on each row in FK-check order -- out of our sorted order -- and two opposite
 *   transfers upgrading those weaker locks to row-exclusive would deadlock. Taking FOR UPDATE
 *   up front both fixes the order and subsumes the FK lock the INSERT wants.
 *
 *   (`withTransaction` still retries on 40P01. That is a backstop, not the plan.)
 *
 * Step 2 -- claim the idempotency key, in this same transaction.
 *
 *   The claim is an `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`. It is not a
 *   "does this key exist?" SELECT followed by an insert: that has a window between the
 *   check and the write, and a concurrent storm of K identical requests drives straight
 *   through it and double-debits.
 *
 *   Because the claim row and the balance updates are written in one transaction, the two
 *   commit or roll back together. There is no state in which a key is recorded as used but
 *   the money did not move, and none in which money moved without the key being burned.
 *
 *   Under concurrency the insert *blocks* on the unique index while the other transaction
 *   holds an uncommitted row with this key. When that transaction ends we either
 *   (a) affected zero rows, meaning it committed and we must return its result, or
 *   (b) inserted successfully, meaning it rolled back and the key is genuinely ours.
 *   The loser therefore never guesses -- it reads the winner's committed decision.
 *
 * Step 3 -- debit with an atomic conditional UPDATE.
 *
 *   `UPDATE ... WHERE id = $wallet AND balance_paise >= $amount` performs the read, the
 *   solvency test and the write as one statement inside the database. Zero rows affected
 *   means "insufficient funds" and nothing was written.
 *
 *   The alternative -- SELECT the balance into the process, subtract in JS, UPDATE the
 *   result -- is a lost update: two concurrent transfers both read the old balance and the
 *   second write erases the first, creating or destroying money. That is the single most
 *   common way this exercise is failed, and no amount of locking discipline in the
 *   application fixes it, because the arithmetic happened outside the database.
 * ---------------------------------------------------------------------------------------
 */
export async function executeMovement(
  tx: Tx,
  input: MovementInput,
  log: EventLogger,
): Promise<MovementOutcome> {
  const { fromWalletId, toWalletId, amountPaise, idempotencyKey, requestSha256, correlationId } =
    input;

  if (fromWalletId === toWalletId) {
    throw ApiError.badRequest('from and to must be different wallets');
  }
  if (amountPaise <= 0n) {
    throw ApiError.badRequest('amount_paise must be greater than zero');
  }

  // ---- Step 1: take both row locks first, in a deterministic order --------------------
  //
  // This MUST happen before the idempotency INSERT. The INSERT carries foreign keys to both
  // wallets, so Postgres takes a FOR KEY SHARE lock on each referenced row while inserting --
  // in FK-check order, which is not our sorted order. If two opposite transfers (A->B and
  // B->A) each hold KEY SHARE on both rows and then try to upgrade to a row-exclusive lock,
  // they deadlock, and the sorted order below would be defeated because the weaker locks were
  // already taken out of order.
  //
  // Acquiring FOR UPDATE on the wallets in sorted id order up front means (a) every
  // transaction in the system requests these locks in the same global order, so no lock cycle
  // can form, and (b) the row-exclusive lock we now hold subsumes the FK KEY SHARE lock the
  // INSERT wants, so the INSERT takes no new conflicting lock. A wallet id that does not exist
  // simply locks nothing here and is caught by the foreign-key check on the INSERT below.
  const lockOrder = [fromWalletId, toWalletId].sort();
  for (const walletId of lockOrder) {
    await tx.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
  }

  // ---- Step 2: claim the key, in this same transaction --------------------------------
  let claimed: TransferRow | undefined;
  try {
    const claim = await tx.query<TransferRow>(
      `INSERT INTO transfers (
         idempotency_key, request_sha256, from_wallet_id, to_wallet_id,
         amount_paise, status, correlation_id
       )
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${TRANSFER_COLUMNS}`,
      [idempotencyKey, requestSha256, fromWalletId, toWalletId, amountPaise.toString(10), correlationId],
    );
    claimed = claim.rows[0];
  } catch (err) {
    // A wallet id that does not exist trips the foreign key. The whole transaction rolls
    // back, so the key is *not* burned by a request that never had a chance to apply.
    if (pgErrorCode(err) === PgErrorCode.FOREIGN_KEY_VIOLATION) {
      const constraint = pgConstraint(err) ?? '';
      const side = constraint.includes('to_wallet') ? 'to' : 'from';
      throw ApiError.notFound('wallet_not_found', `the "${side}" wallet does not exist`);
    }
    throw err;
  }

  if (claimed === undefined) {
    // Our INSERT affected no rows, which -- per the blocking behaviour described above --
    // means the holder of this key has committed. Under READ COMMITTED this statement takes
    // a fresh snapshot, so it can see that committed row.
    const existingResult = await tx.query<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS} FROM transfers WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const existing = existingResult.rows[0];

    if (existing === undefined) {
      // Not reachable: ON CONFLICT DO NOTHING affected zero rows, so a committed row with
      // this key exists. Fail loudly rather than fall through to a second debit.
      throw new Error(
        `idempotency claim for key ${idempotencyKey} was lost but no committed row was found`,
      );
    }

    if (existing.request_sha256 !== requestSha256) {
      log.warn(
        {
          event: 'transfer.idempotency_conflict',
          idempotency_key: idempotencyKey,
          existing_transfer_id: existing.id,
        },
        'idempotency key reused with a different request body',
      );
      return { kind: 'key_conflict', existing };
    }

    if (existing.status === 'pending') {
      // Also not reachable: 'pending' only exists inside the owning transaction, which
      // resolves it to applied/declined before committing. Surfaced as a distinct outcome
      // instead of being silently treated as a success.
      log.error(
        { event: 'transfer.replay_saw_pending', transfer_id: existing.id },
        'observed a committed pending transfer',
      );
      return { kind: 'in_progress', existing };
    }

    log.info(
      {
        event: 'transfer.idempotent_replay',
        transfer_id: existing.id,
        status: existing.status,
        idempotency_key: idempotencyKey,
      },
      'served original result for a replayed idempotency key',
    );
    return { kind: 'replay', transfer: existing, replay: true };
  }

  const transferId = claimed.id;
  log.info(
    {
      event: 'transfer.created',
      transfer_id: transferId,
      from_wallet_id: fromWalletId,
      to_wallet_id: toWalletId,
      amount_paise: amountPaise.toString(10),
      idempotency_key: idempotencyKey,
    },
    'transfer claimed; applying movement',
  );

  // ---- Step 3: conditional debit ------------------------------------------------------
  // The wallets are already locked FOR UPDATE from step 1, so this UPDATE never waits on a
  // lock it does not already hold. The `WHERE balance_paise >= amount` predicate is what
  // makes the debit atomic: zero rows affected means insufficient funds, with nothing
  // written, so there is no read-modify-write window in which a balance could go negative.
  const debit = await tx.query(
    `UPDATE wallets
        SET balance_paise = balance_paise - $1::bigint,
            updated_at    = now()
      WHERE id = $2
        AND balance_paise >= $1::bigint`,
    [amountPaise.toString(10), fromWalletId],
  );

  if (debit.rowCount === 0) {
    // Declined. No balance was touched, and the decision is committed against the key so a
    // retry replays the same decline rather than getting a second chance at the money.
    const declined = await tx.query<TransferRow>(
      `UPDATE transfers
          SET status          = 'declined_insufficient_funds',
              declined_reason = 'insufficient_funds',
              settled_at      = now()
        WHERE id = $1
        RETURNING ${TRANSFER_COLUMNS}`,
      [transferId],
    );

    const row = declined.rows[0];
    if (row === undefined) throw new Error(`transfer ${transferId} vanished mid-transaction`);

    log.info(
      {
        event: 'transfer.declined',
        transfer_id: transferId,
        reason: 'insufficient_funds',
        from_wallet_id: fromWalletId,
        amount_paise: amountPaise.toString(10),
      },
      'transfer declined for insufficient funds',
    );
    return { kind: 'declined', transfer: row, replay: false };
  }

  log.info(
    {
      event: 'transfer.debited',
      transfer_id: transferId,
      wallet_id: fromWalletId,
      amount_paise: amountPaise.toString(10),
    },
    'sender debited',
  );

  const credit = await tx.query(
    `UPDATE wallets
        SET balance_paise = balance_paise + $1::bigint,
            updated_at    = now()
      WHERE id = $2`,
    [amountPaise.toString(10), toWalletId],
  );

  if (credit.rowCount !== 1) {
    // Cannot happen while the foreign key holds, but a credit that silently affects zero
    // rows would destroy money, so it must abort the transaction rather than be logged.
    throw new Error(
      `credit to wallet ${toWalletId} affected ${String(credit.rowCount)} rows; aborting to preserve conservation`,
    );
  }

  log.info(
    {
      event: 'transfer.credited',
      transfer_id: transferId,
      wallet_id: toWalletId,
      amount_paise: amountPaise.toString(10),
    },
    'recipient credited',
  );

  const applied = await tx.query<TransferRow>(
    `UPDATE transfers
        SET status     = 'applied',
            settled_at = now()
      WHERE id = $1
      RETURNING ${TRANSFER_COLUMNS}`,
    [transferId],
  );

  const row = applied.rows[0];
  if (row === undefined) throw new Error(`transfer ${transferId} vanished mid-transaction`);

  log.info(
    { event: 'transfer.applied', transfer_id: transferId, amount_paise: amountPaise.toString(10) },
    'transfer applied',
  );
  return { kind: 'applied', transfer: row, replay: false };
}

/**
 * Race-free get-or-create.
 *
 * `INSERT ... ON CONFLICT (user_id) DO NOTHING` plus a re-SELECT on the losing path. The
 * uniqueness that makes this safe lives in the `wallets_user_id_uniq` constraint, so it
 * holds across processes, across instances and across a restart -- unlike a mutex or a
 * cache in one process, which stops working the moment a second replica exists.
 *
 * The anti-pattern is `SELECT`, and if nothing came back, `INSERT`. Fifty concurrent
 * requests for a fresh user all observe "no wallet" and all proceed to insert; without the
 * constraint that is two-plus wallets, and with the constraint but no conflict handling it
 * is a 500.
 */
export interface WalletRow {
  id: string;
  user_id: string;
  balance_paise: bigint;
  created_at: Date;
  updated_at: Date;
}

const WALLET_COLUMNS = 'id, user_id, balance_paise, created_at, updated_at';

export async function getOrCreateWallet(
  userId: string,
): Promise<{ wallet: WalletRow; created: boolean }> {
  const inserted = await pool.query<WalletRow>(
    `INSERT INTO wallets (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING ${WALLET_COLUMNS}`,
    [userId],
  );

  const createdRow = inserted.rows[0];
  if (createdRow !== undefined) {
    return { wallet: createdRow, created: true };
  }

  // Lost the insert race (or the wallet already existed). Read the winner's row.
  const existing = await pool.query<WalletRow>(
    `SELECT ${WALLET_COLUMNS} FROM wallets WHERE user_id = $1`,
    [userId],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error(`wallet insert for user ${userId} conflicted but no wallet row was found`);
  }
  return { wallet: row, created: false };
}

export async function findWalletById(walletId: string): Promise<WalletRow | undefined> {
  const result = await pool.query<WalletRow>(
    `SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = $1`,
    [walletId],
  );
  return result.rows[0];
}

export async function findTransferById(transferId: string): Promise<TransferRow | undefined> {
  const result = await pool.query<TransferRow>(
    `SELECT ${TRANSFER_COLUMNS} FROM transfers WHERE id = $1`,
    [transferId],
  );
  return result.rows[0];
}
