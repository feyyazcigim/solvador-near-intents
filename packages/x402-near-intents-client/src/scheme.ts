/**
 * Payer-side x402 plugin for `near-intents-exact`.
 *
 * Recognizes the scheme in `accepts[]`, derives the intents account from the
 * connected wallet, (optionally) pre-checks the Intents balance over public RPC,
 * builds the payment intent, and signs it — ERC-191 for EVM wallets (the
 * default), NEP-413 for ed25519 wallets. Returns the scheme-specific payload the
 * facilitator's `verify`/`settle` consume.
 *
 * STALE_SALT handling: the salt can rotate between the merchant issuing a nonce
 * and the payer signing. That surfaces as a *retriable* settle error; the x402
 * client transport re-requests the resource (fresh 402 → fresh nonce) and calls
 * `createPaymentPayload` again. Use {@link isRetriableSettleError} to drive that
 * one retry.
 */
import {
  fromBase64,
  IntentsVerifier,
  NEAR_INTENTS_EXACT_SCHEME,
  randomNonce,
  transfer,
  type IntentMessageParams,
  type NearIntentsExtra,
  type NearIntentsPaymentPayload,
} from "@solvador/near-intents-core";
import type { PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { signIntentMessage } from "./sign.js";
import { walletSignerId, type NearIntentsClientWallet } from "./wallet.js";

/** Thrown when the payer's Intents balance can't cover the payment. */
export class NearIntentsInsufficientFundsError extends Error {
  constructor(
    readonly signerId: string,
    readonly asset: string,
    readonly required: bigint,
    readonly balance: bigint,
    /** Where to deposit, from `PaymentRequirements.extra.depositHint`, if any. */
    readonly depositHint?: string,
  ) {
    super(`Intents balance ${balance} < ${required} of ${asset} for ${signerId}`);
    this.name = "NearIntentsInsufficientFundsError";
  }
}

export type NearIntentsClientOptions = {
  /** Verifier for the optional public-RPC balance precheck. */
  verifier?: IntentsVerifier;
  /** Precheck balance before signing (default true when a verifier is provided). */
  precheckBalance?: boolean;
  /** Verifying contract (default `intents.near`). */
  verifyingContract?: string;
  /** Injectable clock (tests). */
  now?: () => number;
};

export class NearIntentsExactClientScheme implements SchemeNetworkClient {
  readonly scheme = NEAR_INTENTS_EXACT_SCHEME;
  private readonly wallet: NearIntentsClientWallet;
  private readonly options: NearIntentsClientOptions;
  private readonly now: () => number;

  constructor(wallet: NearIntentsClientWallet, options: NearIntentsClientOptions = {}) {
    this.wallet = wallet;
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** The intents account id (signer_id) this wallet pays from. */
  signerId(): string {
    return walletSignerId(this.wallet);
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    const signerId = this.signerId();
    const extra = (requirements.extra ?? {}) as NearIntentsExtra;

    // Nonce: prefer the merchant-issued (salt-versioned) nonce; fall back to a
    // legacy random nonce if the merchant didn't embed one.
    const nonce = extra.nonce ? fromBase64(extra.nonce) : randomNonce();
    const deadline =
      extra.deadline ??
      new Date(this.now() + (requirements.maxTimeoutSeconds ?? 300) * 1000).toISOString();

    const params: IntentMessageParams = {
      signerId,
      deadline,
      intents: [transfer(requirements.payTo, { [requirements.asset]: requirements.amount })],
      nonce,
      ...(extra.verifyingContract ? { verifyingContract: extra.verifyingContract } : {}),
    };

    if (this.options.verifier && (this.options.precheckBalance ?? true)) {
      const [bal] = await this.options.verifier.mtBatchBalanceOf(signerId, [requirements.asset]);
      const required = BigInt(requirements.amount);
      if ((bal ?? 0n) < required) {
        throw new NearIntentsInsufficientFundsError(
          signerId,
          requirements.asset,
          required,
          bal ?? 0n,
          extra.depositHint,
        );
      }
    }

    const multiPayload = await signIntentMessage(this.wallet, params);
    const payload: NearIntentsPaymentPayload = { multiPayload };
    return { x402Version, payload: payload as unknown as Record<string, unknown> };
  }
}

/** True when a settle response's error is safe to retry once (fresh nonce/quote). */
export function isRetriableSettleError(response: {
  errorReason?: string;
  extra?: Record<string, unknown>;
}): boolean {
  if (response.extra && typeof response.extra.retriable === "boolean") return response.extra.retriable;
  return response.errorReason === "STALE_SALT" || response.errorReason === "QUOTE_EXPIRED";
}
