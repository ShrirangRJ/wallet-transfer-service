/**
 * Money is integer paise, end to end.
 *
 * Storage is BIGINT, in-process representation is `bigint`, and arithmetic on balances
 * happens only inside SQL. There is no `number` and no `Number` operator anywhere on the
 * money path except this file's single boundary conversion, which asserts the value is a
 * safe integer before it becomes JSON.
 */

/** JSON can only carry an IEEE-754 double, so refuse anything that would lose precision. */
export function paiseToJson(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`paise value ${value.toString()} exceeds the JSON-safe integer range`);
  }
  return Number(value);
}

/**
 * Accept an amount from a client as either a JSON integer or a decimal string, and reject
 * anything that even looks like a float or a rupee-decimal. `1000` and `"1000"` are valid
 * paise; `10.5`, `"10.50"`, `1e3` and `"₹10"` are not.
 */
export function parsePaise(input: unknown): bigint {
  if (typeof input === 'bigint') return input;

  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) {
      throw new AmountFormatError(
        'amount_paise must be an integer number of paise (no decimals, no exponent notation)',
      );
    }
    return BigInt(input);
  }

  if (typeof input === 'string') {
    if (!/^-?\d+$/.test(input.trim())) {
      throw new AmountFormatError('amount_paise must be a plain integer string of paise');
    }
    return BigInt(input.trim());
  }

  throw new AmountFormatError('amount_paise must be an integer or an integer string');
}

export class AmountFormatError extends Error {}
