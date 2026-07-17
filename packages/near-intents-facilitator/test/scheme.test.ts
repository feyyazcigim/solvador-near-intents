import assert from "node:assert/strict";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  buildDefusePayloadJson,
  encodeVersionedNonce,
  evmAddressFromSecpPublicKey,
  type IntentsVerifier,
  type NearIntentsSigner,
  signErc191,
  toBase64,
  transfer,
} from "@solvador/near-intents-core";
import { NearIntentsExactScheme } from "../src/scheme.js";

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
const SALT = "a1b2c3d4";
const ASSET = "nep141:usdt.tether-token.near";
const PAY_TO = "merchant.near";
const AMOUNT = "1000000";

const SK = new Uint8Array(32).fill(0x42);
const SIGNER_ID = evmAddressFromSecpPublicKey(secp256k1.getPublicKey(SK, false));

/** A verifier stub (classes with private fields need a cast). */
function fakeVerifier(over: Partial<Record<keyof IntentsVerifier, unknown>> = {}): IntentsVerifier {
  return {
    contractId: "intents.near",
    isNonceUsed: async () => false,
    mtBatchBalanceOf: async () => [10_000_000n],
    simulateIntents: async () => ({
      intents_executed: [],
      logs: [],
      min_deadline: "",
      state: { fee: 0, current_salt: SALT },
    }),
    hasPublicKey: async () => true,
    currentSalt: async () => SALT,
    isValidSalt: async () => true,
    ...over,
  } as unknown as IntentsVerifier;
}

function fakeSigner(executeIntents?: NearIntentsSigner["executeIntents"]): {
  signer: NearIntentsSigner;
  calls: () => number;
} {
  let calls = 0;
  const signer: NearIntentsSigner = {
    accountId: "relayer.near",
    getRelayerIds: () => ["relayer.near"],
    executeIntents:
      executeIntents ??
      (async () => {
        calls++;
        return {
          transactionHash: "TXHASH",
          success: true,
          relayerId: "relayer.near",
          logs: [],
          status: { SuccessValue: "" },
          outcome: {},
        };
      }),
  };
  return { signer, calls: () => calls };
}

function makeScheme(verifier: IntentsVerifier, signer: NearIntentsSigner) {
  return new NearIntentsExactScheme({ signer, verifier, now: () => NOW });
}

function buildPayment(
  overrides: { amount?: string; payTo?: string; asset?: string } = {},
): { payload: PaymentPayload; requirements: PaymentRequirements; nonceB64: string } {
  const nonce = encodeVersionedNonce({ salt: SALT, deadline: NOW + 300_000 });
  const nonceB64 = toBase64(nonce);
  const deadline = new Date(NOW + 200_000).toISOString();
  const asset = overrides.asset ?? ASSET;
  const payTo = overrides.payTo ?? PAY_TO;
  const amount = overrides.amount ?? AMOUNT;
  const message = buildDefusePayloadJson({
    signerId: SIGNER_ID,
    deadline,
    intents: [transfer(payTo, { [asset]: amount })],
    nonce,
  });
  const mp = signErc191(message, SK);
  const requirements: PaymentRequirements = {
    scheme: "near-intents-exact",
    network: "near:mainnet",
    asset: ASSET,
    amount: AMOUNT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { nonce: nonceB64 },
  };
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { multiPayload: mp },
  };
  return { payload, requirements, nonceB64 };
}

test("verify accepts a well-formed ERC-191 payment", async () => {
  const scheme = makeScheme(fakeVerifier(), fakeSigner().signer);
  const { payload, requirements } = buildPayment();
  const res = await scheme.verify(payload, requirements);
  assert.equal(res.isValid, true);
  assert.equal(res.payer, SIGNER_ID);
});

test("settle submits execute_intents once and is idempotent on re-settle", async () => {
  const { signer, calls } = fakeSigner();
  const scheme = makeScheme(fakeVerifier(), signer);
  const { payload, requirements } = buildPayment();

  const first = await scheme.settle(payload, requirements);
  assert.equal(first.success, true);
  assert.equal(first.transaction, "TXHASH");
  assert.equal((first.extra?.receipt as { kind: string }).kind, "near-tx");

  const second = await scheme.settle(payload, requirements);
  assert.equal(second.success, true);
  assert.equal(second.transaction, "TXHASH");
  assert.equal(calls(), 1, "execute_intents must run exactly once for the same (signer_id, nonce)");
});

test("verify rejects a wrong amount as WRONG_AMOUNT", async () => {
  const scheme = makeScheme(fakeVerifier(), fakeSigner().signer);
  // Sign for a different amount than the requirements demand.
  const { payload } = buildPayment({ amount: "500000" });
  const requirements = buildPayment().requirements; // demands AMOUNT=1000000
  // Re-point the payload's nonce match by reusing the mismatched payload's extra:
  const res = await scheme.verify(payload, { ...requirements, extra: (payload.accepted as PaymentRequirements).extra });
  assert.equal(res.isValid, false);
  assert.equal(res.invalidReason, "WRONG_AMOUNT");
});

test("verify rejects a spent nonce as NONCE_ALREADY_USED", async () => {
  const scheme = makeScheme(fakeVerifier({ isNonceUsed: async () => true }), fakeSigner().signer);
  const { payload, requirements } = buildPayment();
  const res = await scheme.verify(payload, requirements);
  assert.equal(res.isValid, false);
  assert.equal(res.invalidReason, "NONCE_ALREADY_USED");
});

test("verify rejects insufficient balance as INSUFFICIENT_FUNDS", async () => {
  const scheme = makeScheme(fakeVerifier({ mtBatchBalanceOf: async () => [1n] }), fakeSigner().signer);
  const { payload, requirements } = buildPayment();
  const res = await scheme.verify(payload, requirements);
  assert.equal(res.isValid, false);
  assert.equal(res.invalidReason, "INSUFFICIENT_FUNDS");
});

test("verify rejects a rotated salt as retriable STALE_SALT", async () => {
  const scheme = makeScheme(fakeVerifier({ isValidSalt: async () => false }), fakeSigner().signer);
  const { payload, requirements } = buildPayment();
  const res = await scheme.verify(payload, requirements);
  assert.equal(res.isValid, false);
  assert.equal(res.invalidReason, "STALE_SALT");
  assert.equal((res.extra as { retriable: boolean }).retriable, true);
});

test("verify rejects a tampered signature as INVALID_SIGNATURE", async () => {
  const scheme = makeScheme(fakeVerifier(), fakeSigner().signer);
  const { payload, requirements } = buildPayment();
  const mp = (payload.payload as { multiPayload: { signature: string } }).multiPayload;
  mp.signature = mp.signature.slice(0, -2) + "11"; // corrupt the base58 tail
  const res = await scheme.verify(payload, requirements);
  assert.equal(res.isValid, false);
  assert.equal(res.invalidReason, "INVALID_SIGNATURE");
});

test("getSigners advertises the relayer id; getExtra is undefined", () => {
  const scheme = makeScheme(fakeVerifier(), fakeSigner().signer);
  assert.deepEqual(scheme.getSigners("near:mainnet"), ["relayer.near"]);
  assert.equal(scheme.getExtra("near:mainnet"), undefined);
});

test("issueNonce returns a versioned nonce carrying the current salt", async () => {
  const scheme = makeScheme(fakeVerifier(), fakeSigner().signer);
  const issued = await scheme.issueNonce(300);
  assert.ok(issued.nonce.length > 0);
  assert.ok(issued.saltExpiresAt > NOW);
});
