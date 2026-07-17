import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentRequirements } from "@x402/core/types";
import {
  parseIntentMessage,
  type MultiPayload,
  type SolverQuote,
  type SolverRelayClient,
} from "@solvador/near-intents-core";
import { createCaseBPayment, localEvmWallet, NoQuoteError } from "../src/index.js";

const OUTPUT_ASSET = "nep141:usdt.tether-token.near";
const INPUT_ASSET = "nep141:wrap.near";
const AMOUNT = "1000000";
const PAY_TO = "merchant.near";

const reqs: PaymentRequirements = {
  scheme: "near-intents-exact",
  network: "near:mainnet",
  asset: OUTPUT_ASSET,
  amount: AMOUNT,
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { deadline: "2026-07-15T12:55:00.000Z" },
};

function fakeRelay(quotes: SolverQuote[]): SolverRelayClient {
  return { quote: async () => quotes } as unknown as SolverRelayClient;
}

const QUOTE: SolverQuote = {
  quote_hash: "QH1",
  defuse_asset_identifier_in: INPUT_ASSET,
  defuse_asset_identifier_out: OUTPUT_ASSET,
  amount_in: "5000000000000000000000000",
  amount_out: AMOUNT,
  expiration_time: "2026-07-15T12:53:00.000Z",
};

test("createCaseBPayment builds token_diff + transfer bound to the quote", async () => {
  const wallet = localEvmWallet(new Uint8Array(32).fill(0x55));
  const result = await createCaseBPayment({ wallet, solverRelay: fakeRelay([QUOTE]), requirements: reqs, inputAsset: INPUT_ASSET });

  const payload = result.payload as { multiPayload: MultiPayload; quoteHashes: string[] };
  assert.deepEqual(payload.quoteHashes, ["QH1"]);

  const parsed = parseIntentMessage(payload.multiPayload);
  const diff = parsed.intents.find((i) => i.intent === "token_diff") as {
    diff: Record<string, string>;
  };
  assert.equal(diff.diff[INPUT_ASSET], `-${QUOTE.amount_in}`);
  assert.equal(diff.diff[OUTPUT_ASSET], AMOUNT);

  const transfer = parsed.intents.find((i) => i.intent === "transfer") as {
    receiver_id: string;
    tokens: Record<string, string>;
  };
  assert.equal(transfer.receiver_id, PAY_TO);
  assert.equal(transfer.tokens[OUTPUT_ASSET], AMOUNT);
});

test("createCaseBPayment throws NoQuoteError when no solver responds", async () => {
  const wallet = localEvmWallet(new Uint8Array(32).fill(0x56));
  await assert.rejects(
    () => createCaseBPayment({ wallet, solverRelay: fakeRelay([]), requirements: reqs, inputAsset: INPUT_ASSET }),
    (e: unknown) => e instanceof NoQuoteError,
  );
});
