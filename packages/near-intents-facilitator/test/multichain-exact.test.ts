import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ExecutionStatusResponse, OneClickClient, OneClickStatus } from "@solvador/near-intents-core";
import { OneClickError } from "@solvador/near-intents-core";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { MultichainExactScheme, registerMultichainExact } from "../src/multichain-exact.js";

const ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ORIGIN = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const PAY_TO = "solvador.near";
const DEPOSIT = "0xDepositAddress";

const requirements: PaymentRequirements = {
  scheme: "multichain-exact",
  network: "near:mainnet",
  asset: ASSET,
  amount: "10000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: {},
};

function statusResponse(status: OneClickStatus, overrides: Record<string, unknown> = {}): ExecutionStatusResponse {
  return {
    correlationId: "corr",
    status,
    updatedAt: "2026-07-15T00:00:00Z",
    swapDetails: { destinationChainTxHashes: [{ hash: "DestTxHash111" }] },
    quoteResponse: {
      correlationId: "corr",
      timestamp: "2026-07-15T00:00:00Z",
      signature: "ed25519:sig",
      quoteRequest: {
        dry: false,
        swapType: "EXACT_OUTPUT",
        slippageTolerance: 100,
        originAsset: ORIGIN,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: ASSET,
        amount: "10000",
        refundTo: "0xpayer",
        refundType: "ORIGIN_CHAIN",
        recipient: PAY_TO,
        recipientType: "DESTINATION_CHAIN",
        deadline: "2026-07-15T01:00:00Z",
        ...overrides,
      },
      quote: {
        depositAddress: DEPOSIT,
        amountIn: "10116",
        amountInFormatted: "0.010116",
        amountInUsd: "0.01",
        minAmountIn: "10014",
        amountOut: "10000",
        amountOutFormatted: "0.01",
        amountOutUsd: "0.01",
        minAmountOut: "10000",
        timeEstimate: 35,
      },
    },
  };
}

function fakeOneClick(seq: Array<ExecutionStatusResponse | OneClickError>): OneClickClient {
  let i = 0;
  return {
    getStatus: async () => {
      const next = seq[Math.min(i++, seq.length - 1)]!;
      if (next instanceof OneClickError) throw next;
      return next;
    },
    getQuote: async () => statusResponse("PENDING_DEPOSIT").quoteResponse,
    submitDepositTx: async () => statusResponse("PROCESSING"),
  } as unknown as OneClickClient;
}

function scheme(seq: Array<ExecutionStatusResponse | OneClickError>): MultichainExactScheme {
  return new MultichainExactScheme({
    oneClick: fakeOneClick(seq),
    pollIntervalMs: 0,
    pollTimeoutMs: 50,
    sleep: async () => {},
  });
}

const payload = (depositAddress = DEPOSIT): PaymentPayload => ({
  x402Version: 2,
  accepted: requirements,
  payload: { depositAddress },
});

test("verify: SUCCESS with matching terms is valid; payer = refundTo", async () => {
  const s = scheme([statusResponse("SUCCESS")]);
  const res = await s.verify(payload(), requirements);
  assert.equal(res.isValid, true);
  assert.equal(res.payer, "0xpayer");
});

test("verify: pending statuses are invalid but retriable", async () => {
  const s = scheme([statusResponse("PROCESSING")]);
  const res = await s.verify(payload(), requirements);
  assert.equal(res.isValid, false);
  assert.equal(res.invalidReason, "DEPOSIT_PENDING");
  assert.equal((res.extra as { retriable: boolean }).retriable, true);
});

test("verify: unknown deposit address → UNKNOWN_DEPOSIT", async () => {
  const s = scheme([new OneClickError("nope", 404)]);
  const res = await s.verify(payload("0xNotOurs"), requirements);
  assert.equal(res.invalidReason, "UNKNOWN_DEPOSIT");
});

test("verify: wrong recipient / asset / amount are rejected", async () => {
  for (const [overrides, code] of [
    [{ recipient: "attacker.near" }, "WRONG_RECIPIENT"],
    [{ destinationAsset: "nep141:usdt.tether-token.near" }, "WRONG_ASSET"],
    [{ amount: "9999" }, "WRONG_AMOUNT"],
    [{ swapType: "EXACT_INPUT" }, "WRONG_AMOUNT"],
  ] as const) {
    const s = scheme([statusResponse("SUCCESS", overrides as Record<string, unknown>)]);
    const res = await s.verify(payload(), requirements);
    assert.equal(res.invalidReason, code, JSON.stringify(overrides));
  }
});

test("settle: SUCCESS produces a signed-status receipt and dest tx hash", async () => {
  const s = scheme([statusResponse("SUCCESS")]);
  const res = await s.settle(payload(), requirements);
  assert.equal(res.success, true);
  assert.equal(res.transaction, "DestTxHash111");
  const receipt = (res.extra as { receipt: { kind: string; status: string } }).receipt;
  assert.equal(receipt.kind, "oneclick-signed-status");
  assert.equal(receipt.status, "SUCCESS");
});

test("settle: polls through PROCESSING to SUCCESS", async () => {
  const s = scheme([statusResponse("PROCESSING"), statusResponse("PROCESSING"), statusResponse("SUCCESS")]);
  const res = await s.settle(payload(), requirements);
  assert.equal(res.success, true);
});

test("settle: REFUNDED fails with DEPOSIT_REFUNDED", async () => {
  const s = scheme([statusResponse("REFUNDED")]);
  const res = await s.settle(payload(), requirements);
  assert.equal(res.success, false);
  assert.equal(res.errorReason, "DEPOSIT_REFUNDED");
});

test("settle: re-settle replays the cached receipt (idempotent)", async () => {
  const s = scheme([statusResponse("SUCCESS")]);
  const first = await s.settle(payload(), requirements);
  const second = await s.settle(payload(), requirements);
  assert.equal(second.success, true);
  assert.equal(second.transaction, first.transaction);
});

test("register: exposes quote path + handler; getExtra advertises it", async () => {
  const registered: Array<{ network: string }> = [];
  const fac = { register: (network: string) => registered.push({ network }) };
  const { scheme: s, quotePath } = registerMultichainExact(fac, {
    oneClick: fakeOneClick([statusResponse("SUCCESS")]),
  });
  assert.equal(registered[0]?.network, "near:mainnet");
  assert.equal(quotePath, "/schemes/multichain-exact/quote");
  assert.deepEqual(s.getExtra("near:mainnet"), { quotePath });
});

// ── fund (gas-sponsored EIP-3009) ─────────────────────────────────────────────

function fundScheme(
  seq: Array<ExecutionStatusResponse | OneClickError>,
  broadcast: (args: { chainId: number; tokenAddress: string }) => Promise<string> = async () => "BaseTx111",
): MultichainExactScheme {
  return new MultichainExactScheme({
    oneClick: fakeOneClick(seq),
    fundBroadcaster: broadcast as never,
    pollIntervalMs: 0,
    pollTimeoutMs: 50,
    sleep: async () => {},
  });
}

const AUTH = {
  from: "0xBfF7716648B7B693a2b1a8b7Ba2E966B6bA8bE92",
  to: DEPOSIT,
  value: "10116",
  validAfter: "0",
  validBefore: String(Math.floor(Date.now() / 1000) + 3600),
  nonce: `0x${"ab".repeat(32)}`,
  signature: `0x${"11".repeat(64)}1b`,
};

test("fund: broadcasts a valid authorization and returns the tx hash", async () => {
  // Non-USDC token (unknown domain) so signature pre-verification is skipped.
  const status = statusResponse("PENDING_DEPOSIT", {
    originAsset: "nep141:base-0x0000000000000000000000000000000000000abc.omft.near",
  });
  let broadcasted: { chainId: number; tokenAddress: string } | undefined;
  const s = fundScheme([status], async (args) => {
    broadcasted = args;
    return "BaseTx111";
  });
  const out = await s.fundDeposit({ depositAddress: DEPOSIT, authorization: AUTH });
  assert.equal(out.txHash, "BaseTx111");
  assert.equal(broadcasted?.chainId, 8453);
  assert.equal(broadcasted?.tokenAddress, "0x0000000000000000000000000000000000000abc");
});

test("fund: rejects when authorization.to ≠ depositAddress", async () => {
  const status = statusResponse("PENDING_DEPOSIT", {
    originAsset: "nep141:base-0x0000000000000000000000000000000000000abc.omft.near",
  });
  const s = fundScheme([status]);
  await assert.rejects(
    () => s.fundDeposit({ depositAddress: DEPOSIT, authorization: { ...AUTH, to: "0xElsewhere" } }),
    /WRONG_RECIPIENT|authorization.to/,
  );
});

test("fund: rejects when value ≠ quote.amountIn", async () => {
  const status = statusResponse("PENDING_DEPOSIT", {
    originAsset: "nep141:base-0x0000000000000000000000000000000000000abc.omft.near",
  });
  const s = fundScheme([status]);
  await assert.rejects(
    () => s.fundDeposit({ depositAddress: DEPOSIT, authorization: { ...AUTH, value: "999" } }),
    /amountIn/,
  );
});

test("fund: rejects non-sponsorable origins and non-fundable statuses", async () => {
  const native = statusResponse("PENDING_DEPOSIT", { originAsset: "nep141:base.omft.near" });
  await assert.rejects(
    () => fundScheme([native]).fundDeposit({ depositAddress: DEPOSIT, authorization: AUTH }),
    /not a sponsorable/,
  );
  const done = statusResponse("SUCCESS", {
    originAsset: "nep141:base-0x0000000000000000000000000000000000000abc.omft.near",
  });
  await assert.rejects(
    () => fundScheme([done]).fundDeposit({ depositAddress: DEPOSIT, authorization: AUTH }),
    /not fundable/,
  );
});

test("fund: bad signature for a KNOWN domain (Base USDC) is rejected before broadcast", async () => {
  // Digest construction needs real hex addresses.
  const hexDeposit = "0x60b854981d8749a0f0e481e772dba6082915c0d7";
  const status = statusResponse("PENDING_DEPOSIT", {
    originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  });
  let called = false;
  const s = fundScheme([status], async () => {
    called = true;
    return "BaseTx111";
  });
  await assert.rejects(
    () => s.fundDeposit({ depositAddress: hexDeposit, authorization: { ...AUTH, to: hexDeposit } }),
    (e: unknown) => (e as { code?: string }).code === "INVALID_SIGNATURE",
  );
  assert.equal(called, false);
});
