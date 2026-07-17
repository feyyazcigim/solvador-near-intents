import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDefusePayloadJson,
  type ExecutionStatusResponse,
  nearTxReceipt,
  oneClickSignedStatusReceipt,
  toBase64,
  transfer,
  utf8ToBytes,
} from "@solvador/near-intents-core";
import { verifyNearTxReceipt, verifyOneClickReceipt } from "../src/index.js";

const SIGNER = "0x1111111111111111111111111111111111111111";
const PAY_TO = "merchant.near";
const ASSET = "nep141:usdt.tether-token.near";
const AMOUNT = "1000000";
const NONCE_B64 = toBase64(new Uint8Array(32).fill(5));

/** Build an execute_intents tx outcome carrying a signed transfer to PAY_TO. */
function txOutcome(over: { receiver_id?: string; success?: boolean; amount?: string } = {}) {
  const message = buildDefusePayloadJson({
    signerId: SIGNER,
    deadline: "2026-07-15T12:55:00.000Z",
    intents: [transfer(PAY_TO, { [ASSET]: over.amount ?? AMOUNT })],
    nonce: new Uint8Array(32).fill(5),
  });
  const mp = { standard: "erc191", payload: message, signature: "secp256k1:unchecked" };
  const args = toBase64(utf8ToBytes(JSON.stringify({ signed: [mp] })));
  return {
    status: over.success === false ? { Failure: {} } : { SuccessValue: "" },
    transaction: {
      receiver_id: over.receiver_id ?? "intents.near",
      actions: [{ FunctionCall: { method_name: "execute_intents", args } }],
    },
    receipts_outcome: [],
  };
}

function mockFetch(outcome: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ result: outcome }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const receipt = nearTxReceipt({
  transactionHash: "TXHASH",
  relayerId: "relayer.near",
  signerId: SIGNER,
  payTo: PAY_TO,
  amount: AMOUNT,
  asset: ASSET,
  nonce: NONCE_B64,
});

test("verifyNearTxReceipt accepts a matching execute_intents transfer", async () => {
  const res = await verifyNearTxReceipt(receipt, { fetchImpl: mockFetch(txOutcome()) });
  assert.equal(res.valid, true);
  assert.equal(res.details?.method, "execute_intents");
});

test("verifyNearTxReceipt rejects a failed transaction", async () => {
  const res = await verifyNearTxReceipt(receipt, { fetchImpl: mockFetch(txOutcome({ success: false })) });
  assert.equal(res.valid, false);
  assert.match(res.reason!, /did not succeed/);
});

test("verifyNearTxReceipt rejects a wrong receiver contract", async () => {
  const res = await verifyNearTxReceipt(receipt, {
    fetchImpl: mockFetch(txOutcome({ receiver_id: "evil.near" })),
  });
  assert.equal(res.valid, false);
  assert.match(res.reason!, /≠ intents.near/);
});

test("verifyNearTxReceipt rejects an amount mismatch between receipt and on-chain intent", async () => {
  // On-chain transfer moved 999999, but the receipt claims 1000000.
  const res = await verifyNearTxReceipt(receipt, { fetchImpl: mockFetch(txOutcome({ amount: "999999" })) });
  assert.equal(res.valid, false);
  assert.match(res.reason!, /no submitted transfer intent matched/);
});

test("verifyNearTxReceipt fails closed when relayerId is missing", async () => {
  const noRelayer = { ...receipt, relayerId: undefined };
  const res = await verifyNearTxReceipt(noRelayer, { fetchImpl: mockFetch(txOutcome()) });
  assert.equal(res.valid, false);
  assert.match(res.reason!, /relayerId/);
});

test("verifyOneClickReceipt accepts SUCCESS and rejects REFUNDED (structural)", async () => {
  const status = (s: string): ExecutionStatusResponse => ({
    correlationId: "c1",
    quoteResponse: {
      correlationId: "c1",
      timestamp: "2026-07-15T12:00:00Z",
      signature: "ed25519:sig",
      quoteRequest: {} as ExecutionStatusResponse["quoteResponse"]["quoteRequest"],
      quote: {} as ExecutionStatusResponse["quoteResponse"]["quote"],
    },
    status: s as ExecutionStatusResponse["status"],
    updatedAt: "2026-07-15T12:01:00Z",
    swapDetails: {},
  });
  const ok = oneClickSignedStatusReceipt({ depositAddress: "0xdep", statusResponse: status("SUCCESS") });
  assert.equal((await verifyOneClickReceipt(ok)).valid, true);

  const refunded = oneClickSignedStatusReceipt({ depositAddress: "0xdep", statusResponse: status("REFUNDED") });
  assert.equal((await verifyOneClickReceipt(refunded)).valid, false);
});
