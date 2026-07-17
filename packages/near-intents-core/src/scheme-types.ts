/**
 * Wire types for the `near-intents-exact` x402 scheme, shared by the facilitator
 * handler and the client plugin. Framework-agnostic (no `@x402/*` dependency)
 * so they live in core.
 *
 * These describe the scheme-specific slots of the x402 envelope:
 *  - `PaymentPayload.payload`  → {@link NearIntentsPaymentPayload}
 *  - `PaymentRequirements.extra` → {@link NearIntentsExtra}
 */
import type { MultiPayload } from "./payload.js";

/** Payment flavor: A = pay in the merchant's token; B = any-token-in (solver swap). */
export type NearIntentsCase = "A" | "B";

/** The scheme-specific `PaymentPayload.payload` a payer submits. */
export type NearIntentsPaymentPayload = {
  /** The signed intent envelope (ERC-191 / NEP-413 / raw_ed25519). */
  multiPayload: MultiPayload;
  /** Case B only: solver quote hashes this intent is bound to. */
  quoteHashes?: string[];
};

/** The scheme-specific `PaymentRequirements.extra` a merchant advertises. */
export type NearIntentsExtra = {
  /** base64 nonce issued by the facilitator's nonce endpoint. */
  nonce?: string;
  /** Epoch-ms after which the embedded salt/nonce may be stale (client retries). */
  saltExpiresAt?: number;
  /** Verifying contract (default `intents.near`). */
  verifyingContract?: string;
  /** ISO-8601 deadline the payer must sign at or before. */
  deadline?: string;
  /** Where to deposit if the payer's Intents balance is short (INSUFFICIENT_FUNDS). */
  depositHint?: string;
  [key: string]: unknown;
};
