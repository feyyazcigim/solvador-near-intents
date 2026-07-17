/**
 * Intent constructors and the signed-message builders.
 *
 * A signed NEAR Intents message carries a `DefusePayload` — signer, deadline,
 * nonce, verifying contract, and a list of `intents`. The exact JSON that gets
 * signed depends on the signing standard (confirmed against the Verifier source,
 * `contracts/defuse/core/src/payload/`):
 *
 *  - **erc191 / raw_ed25519 / string standards** sign the FULL DefusePayload:
 *    `{ signer_id, verifying_contract, deadline, nonce (base64), intents }`.
 *  - **nep413** signs a REDUCED `Nep413DefuseMessage`:
 *    `{ signer_id, deadline, intents }` — `verifying_contract` comes from the
 *    envelope `recipient`, and `nonce` from the envelope `nonce`.
 *
 * The contract verifies the signature over the exact received bytes and only
 * afterwards `serde_json`-parses (order-independent). So the object key order we
 * emit is a client convention; we fix it to the Rust struct order. What is
 * mandatory is that the bytes we sign are the bytes we submit — guaranteed here
 * because each message string is built once and both signed and sent.
 */
import { INTENTS_CONTRACT_ID } from "./constants.js";
import { toBase64 } from "./bytes.js";
import type { MultiPayloadStandard } from "./payload.js";

/** A signed integer amount, as a decimal string (token_diff deltas). */
export type SignedAmount = string;

/**
 * `token_diff` — an atomic swap. `diff` maps token id → signed delta:
 * negative = spent (token in), positive = received (token out). The protocol
 * fee is taken from the negative deltas.
 */
export type TokenDiffIntent = {
  intent: "token_diff";
  diff: Record<string, SignedAmount>;
  memo?: string;
  referral?: string;
};

/** `transfer` — move multi-tokens to another Intents account (intents-internal). */
export type TransferIntent = {
  intent: "transfer";
  receiver_id: string;
  tokens: Record<string, string>;
  memo?: string;
};

/** `ft_withdraw` — withdraw a NEP-141 out of Intents to a NEAR account. */
export type FtWithdrawIntent = {
  intent: "ft_withdraw";
  token: string;
  receiver_id: string;
  amount: string;
  memo?: string;
  msg?: string;
  storage_deposit?: string;
  min_gas?: string;
};

/** `native_withdraw` — withdraw yoctoNEAR (debits the wrap.near balance). */
export type NativeWithdrawIntent = {
  intent: "native_withdraw";
  receiver_id: string;
  amount: string;
};

export type Intent =
  | TokenDiffIntent
  | TransferIntent
  | FtWithdrawIntent
  | NativeWithdrawIntent
  | { intent: string; [key: string]: unknown };

// ── Intent constructors (omit undefined optional fields for stable JSON) ──────

/** Build a `transfer` intent moving `tokens` to `receiverId`'s Intents account. */
export function transfer(
  receiverId: string,
  tokens: Record<string, string>,
  opts: { memo?: string } = {},
): TransferIntent {
  return { intent: "transfer", receiver_id: receiverId, tokens, ...pick(opts, ["memo"]) };
}

/** Build a `token_diff` swap intent from a signed-delta map. */
export function tokenDiff(
  diff: Record<string, SignedAmount>,
  opts: { memo?: string; referral?: string } = {},
): TokenDiffIntent {
  return { intent: "token_diff", diff, ...pick(opts, ["memo", "referral"]) };
}

/** Build an `ft_withdraw` intent. */
export function ftWithdraw(args: Omit<FtWithdrawIntent, "intent">): FtWithdrawIntent {
  return { intent: "ft_withdraw", ...args };
}

/** Build a `native_withdraw` intent (amount in yoctoNEAR). */
export function nativeWithdraw(receiverId: string, amount: string): NativeWithdrawIntent {
  return { intent: "native_withdraw", receiver_id: receiverId, amount };
}

// ── Message builders ──────────────────────────────────────────────────────────

/** Parameters shared by both message forms. */
export type IntentMessageParams = {
  signerId: string;
  /** ISO-8601 string or a Date (serialized with `toISOString()`). */
  deadline: string | Date;
  intents: Intent[];
  /** 32-byte nonce (base64-encoded into the full DefusePayload form). */
  nonce: Uint8Array;
  /** Defaults to `intents.near`. */
  verifyingContract?: string;
};

/** Normalize a deadline input to an RFC-3339 / ISO-8601 UTC string. */
export function toDeadlineString(deadline: string | Date): string {
  return typeof deadline === "string" ? deadline : deadline.toISOString();
}

/**
 * The FULL DefusePayload JSON string (erc191 / raw_ed25519), key order
 * `signer_id, verifying_contract, deadline, nonce, intents`.
 */
export function buildDefusePayloadJson(p: IntentMessageParams): string {
  return JSON.stringify({
    signer_id: p.signerId,
    verifying_contract: p.verifyingContract ?? INTENTS_CONTRACT_ID,
    deadline: toDeadlineString(p.deadline),
    nonce: toBase64(p.nonce),
    intents: p.intents,
  });
}

/**
 * The REDUCED Nep413DefuseMessage JSON string (nep413), key order
 * `signer_id, deadline, intents`. `nonce` and `recipient` ride in the envelope.
 */
export function buildNep413MessageJson(p: IntentMessageParams): string {
  return JSON.stringify({
    signer_id: p.signerId,
    deadline: toDeadlineString(p.deadline),
    intents: p.intents,
  });
}

/** Build the correct signed-message string for the given signing standard. */
export function buildIntentMessage(standard: MultiPayloadStandard, p: IntentMessageParams): string {
  return standard === "nep413" ? buildNep413MessageJson(p) : buildDefusePayloadJson(p);
}

/** Copy only the defined keys in `keys` from `obj` (drops `undefined`). */
function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
