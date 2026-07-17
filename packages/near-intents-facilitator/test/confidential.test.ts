import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionStatusResponse, OneClickClient, OneClickStatus } from "@solvador/near-intents-core";
import { ConfidentialSettlement } from "../src/confidential.js";

function statusResponse(status: OneClickStatus): ExecutionStatusResponse {
  return {
    correlationId: "c1",
    quoteResponse: {
      correlationId: "c1",
      timestamp: "2026-07-15T12:00:00Z",
      signature: "ed25519:sig",
      quoteRequest: {} as ExecutionStatusResponse["quoteResponse"]["quoteRequest"],
      quote: {} as ExecutionStatusResponse["quoteResponse"]["quote"],
    },
    status,
    updatedAt: "2026-07-15T12:01:00Z",
    swapDetails: {},
  };
}

/** A 1Click client stub that returns a scripted sequence of statuses. */
function fakeOneClick(sequence: OneClickStatus[]): OneClickClient {
  let i = 0;
  return {
    getStatus: async () => statusResponse(sequence[Math.min(i++, sequence.length - 1)]!),
  } as unknown as OneClickClient;
}

test("disabled confidential settlement refuses to settle", async () => {
  const cs = new ConfidentialSettlement({ enabled: false, oneClick: fakeOneClick(["SUCCESS"]) });
  assert.equal(cs.enabled, false);
  await assert.rejects(() => cs.settleByDeposit("0xdep"), /disabled/);
});

test("enabled: polls to SUCCESS and builds a signed-status receipt", async () => {
  const cs = new ConfidentialSettlement({
    enabled: true,
    oneClick: fakeOneClick(["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"]),
    pollIntervalMs: 0,
    sleep: async () => {},
  });
  const res = await cs.settleByDeposit("0xdep", { paymentId: "pay_1" });
  assert.equal(res.status, "SUCCESS");
  assert.equal(res.success, true);
  assert.equal(res.receipt.kind, "oneclick-signed-status");
  assert.equal(res.receipt.paymentId, "pay_1");
  assert.equal(res.receipt.quoteSignature, "ed25519:sig");
});

test("enabled: REFUNDED is terminal and reported as unsuccessful", async () => {
  const cs = new ConfidentialSettlement({
    enabled: true,
    oneClick: fakeOneClick(["REFUNDED"]),
    sleep: async () => {},
  });
  const res = await cs.settleByDeposit("0xdep");
  assert.equal(res.status, "REFUNDED");
  assert.equal(res.success, false);
});
