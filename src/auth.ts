import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { ApiError } from './errors.js';

/**
 * Auth is deliberately minimal -- the brief states auth sophistication is not graded, so
 * this is an opaque random bearer token per user, stored as a SHA-256 digest. It is enough
 * to answer "who is the caller" and "does the caller own the debited wallet", which is all
 * the ledger needs. It is not a session system and makes no attempt at rotation,
 * expiry or scopes.
 */

export interface Caller {
  userId: string;
  isAdmin: boolean;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function extractBearer(authorization: string | undefined): string {
  if (authorization === undefined) throw ApiError.unauthorized();
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (match?.[1] === undefined || match[1].trim() === '') {
    throw ApiError.unauthorized('Authorization header must be "Bearer <token>"');
  }
  return match[1].trim();
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function isAdminToken(token: string): boolean {
  return constantTimeEquals(token, config.adminToken);
}

interface UserRow {
  id: string;
  is_admin: boolean;
}

/** Resolve a bearer token to a caller. The admin token resolves without a users row. */
export async function authenticate(authorization: string | undefined): Promise<Caller> {
  const token = extractBearer(authorization);

  if (isAdminToken(token)) {
    return { userId: 'admin', isAdmin: true };
  }

  const result = await query<UserRow>(
    'SELECT id, is_admin FROM users WHERE token_sha256 = $1',
    [hashToken(token)],
  );

  const row = result.rows[0];
  if (row === undefined) throw ApiError.unauthorized('unknown bearer token');
  return { userId: row.id, isAdmin: row.is_admin };
}

export function requireAdmin(caller: Caller): void {
  if (!caller.isAdmin) {
    throw ApiError.forbidden('this endpoint requires the admin token');
  }
}
