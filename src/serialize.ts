import type { TransferRow, WalletRow } from './ledger.js';
import { paiseToJson } from './money.js';

export interface WalletBody {
  wallet_id: string;
  user_id: string;
  balance_paise: number;
  created_at: string;
  updated_at: string;
}

export function walletBody(wallet: WalletRow): WalletBody {
  return {
    wallet_id: wallet.id,
    user_id: wallet.user_id,
    balance_paise: paiseToJson(wallet.balance_paise),
    created_at: wallet.created_at.toISOString(),
    updated_at: wallet.updated_at.toISOString(),
  };
}

export interface TransferBody {
  transfer_id: string;
  status: string;
  from: string;
  to: string;
  amount_paise: number;
  idempotency_key: string;
  declined_reason: string | null;
  created_at: string;
  settled_at: string | null;
}

/**
 * Every field here is read from the committed `transfers` row, which is why a replay
 * serialises byte-for-byte identically to the response the original request received --
 * including the timestamps. Nothing is derived from the current request.
 *
 * Whether a given response did the work or replayed someone else's is carried out of band,
 * in the `X-Idempotent-Replay` header and the HTTP status (201 for the one request that
 * applied it, 200 for replays). Keeping it out of the body is deliberate: it means a client
 * comparing bodies across a retry storm sees no difference at all.
 */
export function transferBody(transfer: TransferRow): TransferBody {
  return {
    transfer_id: transfer.id,
    status: transfer.status,
    from: transfer.from_wallet_id,
    to: transfer.to_wallet_id,
    amount_paise: paiseToJson(transfer.amount_paise),
    idempotency_key: transfer.idempotency_key,
    declined_reason: transfer.declined_reason,
    created_at: transfer.created_at.toISOString(),
    settled_at: transfer.settled_at === null ? null : transfer.settled_at.toISOString(),
  };
}
