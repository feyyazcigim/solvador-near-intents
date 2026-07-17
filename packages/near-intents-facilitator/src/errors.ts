/**
 * Error taxonomy for `near-intents-exact` (spec §4.6).
 *
 * Codes surface in the x402 envelope as `VerifyResponse.invalidReason` /
 * `SettleResponse.errorReason`. `STALE_SALT` and `QUOTE_EXPIRED` are marked
 * retriable so the client SDK auto-retries once (fresh nonce / fresh quote).
 */

export const NearIntentsErrorCode = {
  /** MultiPayload signature did not verify. */
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  /** Payload/message could not be parsed or is structurally wrong. */
  MALFORMED_PAYLOAD: "MALFORMED_PAYLOAD",
  /** Recovered signer ≠ the message's signer_id. */
  SIGNER_MISMATCH: "SIGNER_MISMATCH",
  /** The intent doesn't pay `payTo`. */
  WRONG_RECIPIENT: "WRONG_RECIPIENT",
  /** The intent's asset ≠ the required asset. */
  WRONG_ASSET: "WRONG_ASSET",
  /** The intent's amount ≠ (or <) the required amount. */
  WRONG_AMOUNT: "WRONG_AMOUNT",
  /** verifying_contract / recipient ≠ intents.near. */
  WRONG_VERIFYING_CONTRACT: "WRONG_VERIFYING_CONTRACT",
  /** The signed nonce ≠ the nonce the facilitator issued. */
  NONCE_MISMATCH: "NONCE_MISMATCH",
  /** The nonce is already spent on-chain. */
  NONCE_ALREADY_USED: "NONCE_ALREADY_USED",
  /** The salt embedded in the nonce has rotated. RETRIABLE. */
  STALE_SALT: "STALE_SALT",
  /** The signed deadline has passed. */
  DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
  /** The payer's Intents balance is below the amount. */
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  /** simulate_intents reported an invariant violation. */
  SIMULATION_FAILED: "SIMULATION_FAILED",
  /** Case B: the solver quote expired before publish. RETRIABLE. */
  QUOTE_EXPIRED: "QUOTE_EXPIRED",
  /** Case B: no solver quote available. */
  NO_QUOTE: "NO_QUOTE",
  /** The relayer submission failed (gas, RPC, revert). */
  RELAYER_ERROR: "RELAYER_ERROR",
  /** A view call or other dependency failed; verification fails closed. */
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  /** Anything unclassified. */
  INTERNAL_ERROR: "INTERNAL_ERROR",

  // ── near-intents-1click (send-to-pay) ─────────────────────────────────────
  /** 1Click doesn't know this deposit address. */
  UNKNOWN_DEPOSIT: "UNKNOWN_DEPOSIT",
  /** Deposit seen/processing but not terminal yet. RETRIABLE (poll again). */
  DEPOSIT_PENDING: "DEPOSIT_PENDING",
  /** 1Click refunded the deposit (late/short/expired). */
  DEPOSIT_REFUNDED: "DEPOSIT_REFUNDED",
  /** 1Click marked the execution failed. */
  DEPOSIT_FAILED: "DEPOSIT_FAILED",
  /** The 1Click quote's terms don't match the advertised requirements. */
  TERMS_MISMATCH: "TERMS_MISMATCH",
} as const;

export type NearIntentsErrorCode =
  (typeof NearIntentsErrorCode)[keyof typeof NearIntentsErrorCode];

/** Codes the client SDK may retry (once) without human intervention. */
export const RETRIABLE_CODES: ReadonlySet<string> = new Set([
  NearIntentsErrorCode.STALE_SALT,
  NearIntentsErrorCode.QUOTE_EXPIRED,
  NearIntentsErrorCode.DEPOSIT_PENDING,
]);

/** True when `code` is safe for the client to retry automatically. */
export function isRetriable(code: string): boolean {
  return RETRIABLE_CODES.has(code);
}

/**
 * A verification/settlement failure carrying a taxonomy code. The scheme catches
 * these and maps them into the x402 response envelope.
 */
export class NearIntentsError extends Error {
  constructor(
    readonly code: NearIntentsErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "NearIntentsError";
  }

  /** Whether the client SDK should retry this error once. */
  get retriable(): boolean {
    return isRetriable(this.code);
  }
}
