/**
 * Receipt types + constructors. A receipt is the portable proof a merchant (or
 * the dashboard, or the reconciliation cron) later verifies with
 * `@solvador/near-receipt`. Two kinds:
 *
 *  - `near-tx` — the public path: an on-chain `execute_intents` transaction on
 *    `intents.near` whose transfer event pays the merchant.
 *  - `oneclick-signed-status` — the confidential path: 1Click's verbatim signed
 *    status payload (the amounts stay private; the signature is the proof).
 */
import { NEAR_INTENTS_EXACT_SCHEME, NEAR_MAINNET_CAIP2 } from "./constants.js";
import type { ExecutionStatusResponse } from "./oneclick.js";

export type ReceiptKind = "near-tx" | "oneclick-signed-status";

/** On-chain `execute_intents` receipt (public path). */
export type NearTxReceipt = {
  kind: "near-tx";
  network: string;
  scheme: string;
  /** Outer transaction hash on `intents.near`. */
  transactionHash: string;
  /** Relayer account that submitted the tx (the tx `sender_account_id`, needed to fetch it). */
  relayerId?: string;
  /** Intents account that authorized the transfer (payer). */
  signerId: string;
  /** Merchant's Intents account that received the funds. */
  payTo: string;
  /** Amount in atomic units. */
  amount: string;
  /** Multi-token id, e.g. `nep141:usdt.tether-token.near`. */
  asset: string;
  /** base64 nonce that was spent (idempotency anchor). */
  nonce: string;
  /** Optional x402 payment id / memo. */
  paymentId?: string;
};

/** 1Click signed-status receipt (confidential path). */
export type OneClickSignedStatusReceipt = {
  kind: "oneclick-signed-status";
  network: string;
  scheme: string;
  depositAddress: string;
  status: string;
  /** 1Click service signature over the quote (dispute proof). */
  quoteSignature: string;
  /** The verbatim signed status payload. */
  statusResponse: ExecutionStatusResponse;
  paymentId?: string;
};

export type NearIntentsReceipt = NearTxReceipt | OneClickSignedStatusReceipt;

/** Build a `near-tx` receipt. */
export function nearTxReceipt(args: {
  transactionHash: string;
  relayerId?: string;
  signerId: string;
  payTo: string;
  amount: string;
  asset: string;
  nonce: string;
  paymentId?: string;
  network?: string;
  scheme?: string;
}): NearTxReceipt {
  return {
    kind: "near-tx",
    network: args.network ?? NEAR_MAINNET_CAIP2,
    scheme: args.scheme ?? NEAR_INTENTS_EXACT_SCHEME,
    transactionHash: args.transactionHash,
    ...(args.relayerId === undefined ? {} : { relayerId: args.relayerId }),
    signerId: args.signerId,
    payTo: args.payTo,
    amount: args.amount,
    asset: args.asset,
    nonce: args.nonce,
    ...(args.paymentId === undefined ? {} : { paymentId: args.paymentId }),
  };
}

/** Build a `oneclick-signed-status` receipt from a 1Click status response. */
export function oneClickSignedStatusReceipt(args: {
  depositAddress: string;
  statusResponse: ExecutionStatusResponse;
  paymentId?: string;
  network?: string;
  scheme?: string;
}): OneClickSignedStatusReceipt {
  return {
    kind: "oneclick-signed-status",
    network: args.network ?? NEAR_MAINNET_CAIP2,
    scheme: args.scheme ?? NEAR_INTENTS_EXACT_SCHEME,
    depositAddress: args.depositAddress,
    status: args.statusResponse.status,
    quoteSignature: args.statusResponse.quoteResponse.signature,
    statusResponse: args.statusResponse,
    ...(args.paymentId === undefined ? {} : { paymentId: args.paymentId }),
  };
}
