import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentRequirements } from "@x402/core/types";
import {
  encodeVersionedNonce,
  type IntentsVerifier,
  type MultiPayload,
  parseIntentMessage,
  recoverSigner,
  toBase64,
} from "@solvador/near-intents-core";
import {
  isRetriableSettleError,
  localEd25519Wallet,
  localEvmWallet,
  NearIntentsExactClientScheme,
  NearIntentsInsufficientFundsError,
} from "../src/index.js";

const SALT = "a1b2c3d4";
const ASSET = "nep141:usdt.tether-token.near";
const AMOUNT = "1000000";
const PAY_TO = "merchant.near";

function requirements(): PaymentRequirements {
  const nonce = encodeVersionedNonce({ salt: SALT, deadline: Date.UTC(2026, 6, 15, 13, 0, 0) });
  return {
    scheme: "near-intents-exact",
    network: "near:mainnet",
    asset: ASSET,
    amount: AMOUNT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { nonce: toBase64(nonce), deadline: "2026-07-15T12:55:00.000Z" },
  };
}

function mpOf(result: { payload: unknown }): MultiPayload {
  return (result.payload as { multiPayload: MultiPayload }).multiPayload;
}

test("EVM wallet → ERC-191 payload that recovers the wallet address and pays the merchant", async () => {
  const wallet = localEvmWallet(new Uint8Array(32).fill(0x11));
  const client = new NearIntentsExactClientScheme(wallet);
  const result = await client.createPaymentPayload(2, requirements());
  const mp = mpOf(result);
  assert.equal(mp.standard, "erc191");

  const recovered = recoverSigner(mp);
  assert.equal(recovered.valid, true);
  assert.equal(recovered.valid && recovered.curve === "secp256k1" && recovered.address, client.signerId());

  const parsed = parseIntentMessage(mp);
  assert.equal(parsed.signerId, client.signerId());
  const transfer = parsed.intents[0] as { intent: string; receiver_id: string; tokens: Record<string, string> };
  assert.equal(transfer.intent, "transfer");
  assert.equal(transfer.receiver_id, PAY_TO);
  assert.equal(transfer.tokens[ASSET], AMOUNT);
});

test("ed25519 wallet → NEP-413 payload that verifies and pays the merchant", async () => {
  const wallet = localEd25519Wallet(new Uint8Array(32).fill(0x22));
  const client = new NearIntentsExactClientScheme(wallet);
  const reqs = requirements();
  const result = await client.createPaymentPayload(2, reqs);
  const mp = mpOf(result);
  assert.equal(mp.standard, "nep413");

  const recovered = recoverSigner(mp);
  assert.equal(recovered.valid, true);
  assert.equal(recovered.valid && recovered.curve === "ed25519" && recovered.accountId, client.signerId());

  const parsed = parseIntentMessage(mp);
  assert.equal(parsed.signerId, client.signerId());
  assert.equal(parsed.nonce, reqs.extra.nonce); // signed the merchant-issued nonce
});

test("balance precheck throws NearIntentsInsufficientFundsError with the deposit hint", async () => {
  const verifier = { mtBatchBalanceOf: async () => [1n] } as unknown as IntentsVerifier;
  const client = new NearIntentsExactClientScheme(localEvmWallet(new Uint8Array(32).fill(0x33)), {
    verifier,
  });
  const reqs = requirements();
  reqs.extra.depositHint = "deposit to 0x… on Base";
  await assert.rejects(
    () => client.createPaymentPayload(2, reqs),
    (e: unknown) => {
      assert.ok(e instanceof NearIntentsInsufficientFundsError);
      assert.equal(e.depositHint, "deposit to 0x… on Base");
      return true;
    },
  );
});

test("isRetriableSettleError reads the retriable flag and STALE_SALT/QUOTE_EXPIRED", () => {
  assert.equal(isRetriableSettleError({ errorReason: "STALE_SALT" }), true);
  assert.equal(isRetriableSettleError({ errorReason: "QUOTE_EXPIRED" }), true);
  assert.equal(isRetriableSettleError({ errorReason: "WRONG_AMOUNT" }), false);
  assert.equal(isRetriableSettleError({ errorReason: "X", extra: { retriable: true } }), true);
});
