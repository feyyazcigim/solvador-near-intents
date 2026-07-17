/**
 * End-to-end `near-intents-exact` round-trip, entirely local (no network) via
 * injected fakes for the chain reads/writes. Demonstrates all four packages
 * working together: merchant issues a nonce → payer signs → facilitator
 * verifies + settles → merchant verifies the receipt.
 *
 *   npm run example
 */
import {
  encodeVersionedNonce,
  type IntentsVerifier,
  type NearIntentsSigner,
  toBase64,
} from "@solvador/near-intents-core";
import { NearIntentsExactScheme } from "@solvador/near-intents-facilitator";
import { NearIntentsExactClientScheme, localEvmWallet } from "@solvador/x402-near-intents-client";
import { verifyNearTxReceipt } from "@solvador/near-receipt";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { buildDefusePayloadJson, transfer, utf8ToBytes } from "@solvador/near-intents-core";

const ASSET = "nep141:usdt.tether-token.near";
const AMOUNT = "1000000"; // 1 USDT (6 dp)
const PAY_TO = "solvador.near";
const SALT = "a1b2c3d4";
const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);

// ── Fakes standing in for the chain ──────────────────────────────────────────
const verifier = {
  contractId: "intents.near",
  isNonceUsed: async () => false,
  mtBatchBalanceOf: async () => [5_000_000n], // payer has 5 USDT
  simulateIntents: async () => ({ intents_executed: [], logs: [], min_deadline: "", state: { fee: 0, current_salt: SALT } }),
  hasPublicKey: async () => true,
  currentSalt: async () => SALT,
  isValidSalt: async () => true,
} as unknown as IntentsVerifier;

const signer: NearIntentsSigner = {
  accountId: "solvador.near",
  getRelayerIds: () => ["solvador.near"],
  executeIntents: async () => ({
    transactionHash: "3xampLeTxHash1111111111111111111111111111111",
    success: true,
    relayerId: "solvador.near",
    logs: [],
    status: { SuccessValue: "" },
    outcome: {},
  }),
};

async function main() {
  const scheme = new NearIntentsExactScheme({ signer, verifier, now: () => NOW });

  // 1) Merchant issues a fresh salt-versioned nonce and advertises requirements.
  const issued = await scheme.issueNonce(300);
  console.log("1. merchant issued nonce:", issued.nonce.slice(0, 16) + "…");
  const requirements: PaymentRequirements = {
    scheme: "near-intents-exact",
    network: "near:mainnet",
    asset: ASSET,
    amount: AMOUNT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { nonce: issued.nonce, deadline: new Date(NOW + 200_000).toISOString() },
  };

  // 2) Payer (an EVM wallet) signs the payment.
  const wallet = localEvmWallet(new Uint8Array(32).fill(0x42));
  const client = new NearIntentsExactClientScheme(wallet, { now: () => NOW });
  console.log("2. payer intents account:", client.signerId());
  const created = await client.createPaymentPayload(2, requirements);
  const paymentPayload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: created.payload };

  // 3) Facilitator verifies (5-step pipeline) then settles (execute_intents).
  const verifyRes = await scheme.verify(paymentPayload, requirements);
  console.log("3a. verify:", verifyRes.isValid ? "VALID" : `INVALID (${verifyRes.invalidReason})`, "payer=", verifyRes.payer);
  const settleRes = await scheme.settle(paymentPayload, requirements);
  console.log("3b. settle:", settleRes.success ? "OK" : `FAIL (${settleRes.errorReason})`, "tx=", settleRes.transaction);

  // Idempotency: a re-settle replays the cached receipt (no second tx).
  const resettle = await scheme.settle(paymentPayload, requirements);
  console.log("3c. re-settle idempotent:", resettle.transaction === settleRes.transaction);

  // 4) Merchant verifies the receipt against the chain (mocked tx fetch here).
  const receipt = (settleRes.extra as { receipt: Parameters<typeof verifyNearTxReceipt>[0] }).receipt;
  const mockChain: typeof fetch = (async () => {
    const message = buildDefusePayloadJson({
      signerId: client.signerId(),
      deadline: requirements.extra.deadline as string,
      intents: [transfer(PAY_TO, { [ASSET]: AMOUNT })],
      nonce: new Uint8Array(32),
    });
    const args = toBase64(utf8ToBytes(JSON.stringify({ signed: [{ standard: "erc191", payload: message, signature: "secp256k1:_" }] })));
    return new Response(
      JSON.stringify({ result: { status: { SuccessValue: "" }, transaction: { receiver_id: "intents.near", actions: [{ FunctionCall: { method_name: "execute_intents", args } }] } } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const check = await verifyNearTxReceipt(receipt, { fetchImpl: mockChain });
  console.log("4. merchant receipt verification:", check.valid ? "VALID ✅" : `INVALID (${check.reason})`);

  console.log("\nDone — 402 → sign → 200 → receipt verified, all local.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
