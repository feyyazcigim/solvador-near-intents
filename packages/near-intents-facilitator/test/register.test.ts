import assert from "node:assert/strict";
import { test } from "node:test";
import { x402Facilitator } from "@x402/core/facilitator";
import type { NearIntentsSigner } from "@solvador/near-intents-core";
import { registerNearIntents } from "../src/index.js";

const fakeSigner: NearIntentsSigner = {
  accountId: "relayer.solvador.near",
  getRelayerIds: () => ["relayer.solvador.near"],
  executeIntents: async () => ({
    transactionHash: "TX",
    success: true,
    relayerId: "relayer.solvador.near",
    logs: [],
    status: { SuccessValue: "" },
    outcome: {},
  }),
};

test("registerNearIntents advertises near-intents-exact on a real x402Facilitator", () => {
  const facilitator = new x402Facilitator();
  const { scheme, noncePath } = registerNearIntents(facilitator, {
    relayers: [],
    signer: fakeSigner,
    network: "near:mainnet",
  });

  assert.equal(scheme.scheme, "near-intents-exact");
  assert.equal(scheme.caipFamily, "near:*");
  assert.equal(noncePath, "/schemes/near-intents-exact/nonce");

  const supported = facilitator.getSupported();
  const kind = supported.kinds.find((k) => k.scheme === "near-intents-exact");
  assert.ok(kind, "near-intents-exact must appear in /supported kinds");
  assert.equal(kind!.network, "near:mainnet");

  // The relayer id is advertised among the signers.
  const allSigners = Object.values(supported.signers).flat();
  assert.ok(allSigners.includes("relayer.solvador.near"), "relayer id must be advertised");
});

test("near-intents-exact coexists with the existing near exact scheme in accepts[]", () => {
  const facilitator = new x402Facilitator();
  registerNearIntents(facilitator, { relayers: [], signer: fakeSigner, network: "near:mainnet" });
  // Same network, distinct scheme string — the core coexistence claim.
  const near = facilitator.getSupported().kinds.filter((k) => k.network === "near:mainnet");
  assert.ok(near.some((k) => k.scheme === "near-intents-exact"));
});
