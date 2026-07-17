/**
 * Case B (any-token-in): the payer holds a token other than the merchant's.
 *
 * Flow: quote `inputAsset → asset` for `exact_amount_out = amount` via the Solver
 * Relay, pick the best offer, and sign ONE MultiPayload containing both a
 * `token_diff` (the funded swap, bound to the quote) and a `transfer` of the
 * merchant's `asset`:`amount` to `payTo`. The facilitator settles it via
 * `publish_intent` with the returned `quoteHashes`.
 *
 * Quotes are short-lived by design; on a `QUOTE_EXPIRED` settle error, re-run
 * this builder to requote (a shorter deadline generally prices better).
 */
import {
  bestQuote,
  fromBase64,
  randomNonce,
  tokenDiff,
  transfer,
  type IntentMessageParams,
  type Intent,
  type NearIntentsExtra,
  type NearIntentsPaymentPayload,
  type SolverRelayClient,
} from "@solvador/near-intents-core";
import type { PaymentPayloadResult, PaymentRequirements } from "@x402/core/types";
import { signIntentMessage } from "./sign.js";
import { walletSignerId, type NearIntentsClientWallet } from "./wallet.js";

/** Thrown when no solver offered a quote for the requested swap. */
export class NoQuoteError extends Error {
  constructor(
    readonly inputAsset: string,
    readonly outputAsset: string,
  ) {
    super(`no solver quote for ${inputAsset} → ${outputAsset}`);
    this.name = "NoQuoteError";
  }
}

export type CreateCaseBPaymentArgs = {
  wallet: NearIntentsClientWallet;
  solverRelay: SolverRelayClient;
  requirements: PaymentRequirements;
  /** The token the payer holds and wants to spend. */
  inputAsset: string;
  x402Version?: number;
  /** Minimum quote validity window (ms). */
  minDeadlineMs?: number;
  now?: () => number;
};

/**
 * Build a Case B payment payload (a signed `token_diff` + `transfer` bound to a
 * solver quote). Returns the x402 payload plus `quoteHashes` in
 * `payload.quoteHashes` for the facilitator's `publish_intent`.
 */
export async function createCaseBPayment(args: CreateCaseBPaymentArgs): Promise<PaymentPayloadResult> {
  const reqs = args.requirements;
  const outputAsset = reqs.asset;
  const outputAmount = reqs.amount;

  const quotes = await args.solverRelay.quote({
    defuse_asset_identifier_in: args.inputAsset,
    defuse_asset_identifier_out: outputAsset,
    exact_amount_out: outputAmount,
    ...(args.minDeadlineMs ? { min_deadline_ms: args.minDeadlineMs } : {}),
  });
  const best = bestQuote(quotes);
  if (!best) throw new NoQuoteError(args.inputAsset, outputAsset);

  const signerId = walletSignerId(args.wallet);
  const extra = (reqs.extra ?? {}) as NearIntentsExtra;
  const nonce = extra.nonce ? fromBase64(extra.nonce) : randomNonce();
  const now = args.now ?? Date.now;
  const deadline =
    extra.deadline ?? new Date(now() + (reqs.maxTimeoutSeconds ?? 300) * 1000).toISOString();

  // token_diff funds the swap (spend inputAsset, receive outputAsset); transfer
  // then pays the merchant. token_diff output (best.amount_out) covers the amount.
  const intents: Intent[] = [
    tokenDiff({ [args.inputAsset]: `-${best.amount_in}`, [outputAsset]: best.amount_out }),
    transfer(reqs.payTo, { [outputAsset]: outputAmount }),
  ];

  const params: IntentMessageParams = {
    signerId,
    deadline,
    intents,
    nonce,
    ...(extra.verifyingContract ? { verifyingContract: extra.verifyingContract } : {}),
  };
  const multiPayload = await signIntentMessage(args.wallet, params);
  const payload: NearIntentsPaymentPayload = { multiPayload, quoteHashes: [best.quote_hash] };
  return { x402Version: args.x402Version ?? 2, payload: payload as unknown as Record<string, unknown> };
}
