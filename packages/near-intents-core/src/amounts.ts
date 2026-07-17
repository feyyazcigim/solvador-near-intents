/**
 * Decimal ↔ atomic-unit conversion. x402 `PaymentRequirements.amount` is already
 * in atomic units, but Case B (any-token-in) and money display need conversion,
 * and it must be exact (no float): all math is on `bigint`.
 */

/** Convert a human decimal amount to atomic units for `decimals` places. */
export function toAtomicUnits(amount: string | number | bigint, decimals: number): bigint {
  if (typeof amount === "bigint") return amount;
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError(`bad decimals: ${decimals}`);
  const s = typeof amount === "number" ? numberToPlainString(amount) : amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a non-negative decimal: ${amount}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    throw new Error(`amount ${amount} has more than ${decimals} fractional digits`);
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** Convert atomic units to a human decimal string (trimmed, no trailing zeros). */
export function fromAtomicUnits(atomic: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError(`bad decimals: ${decimals}`);
  const neg = atomic < 0n;
  const abs = neg ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const sign = neg ? "-" : "";
  if (frac === 0n) return `${sign}${whole}`;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fracStr}`;
}

/** Render a JS number without scientific notation (small helper for `toAtomicUnits`). */
function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not finite: ${n}`);
  if (!n.toString().includes("e") && !n.toString().includes("E")) return n.toString();
  // Expand exponential notation deterministically.
  return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}
