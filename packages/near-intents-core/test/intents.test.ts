import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519ToAccountId, evmAddressFromSecpPublicKey } from "../src/accounts.js";
import { toBase64 } from "../src/bytes.js";
import { INTENTS_CONTRACT_ID } from "../src/constants.js";
import {
  buildDefusePayloadJson,
  buildNep413MessageJson,
  tokenDiff,
  transfer,
} from "../src/intents.js";
import { signErc191, signNep413, verifyErc191, verifyNep413 } from "../src/payload.js";

const NONCE = new Uint8Array(32).fill(1);
const DEADLINE = "2026-07-15T00:00:00.000Z";
const USDT = "nep141:usdt.tether-token.near";

test("buildNep413MessageJson emits the reduced {signer_id, deadline, intents}", () => {
  const json = buildNep413MessageJson({
    signerId: "alice.near",
    deadline: DEADLINE,
    intents: [transfer("merchant.near", { [USDT]: "1000000" })],
    nonce: NONCE,
  });
  assert.deepEqual(Object.keys(JSON.parse(json)), ["signer_id", "deadline", "intents"]);
  assert.equal(
    json,
    '{"signer_id":"alice.near","deadline":"2026-07-15T00:00:00.000Z",' +
      '"intents":[{"intent":"transfer","receiver_id":"merchant.near",' +
      '"tokens":{"nep141:usdt.tether-token.near":"1000000"}}]}',
  );
});

test("buildDefusePayloadJson emits the full 5-field payload with base64 nonce, struct order", () => {
  const json = buildDefusePayloadJson({
    signerId: "0xabc0000000000000000000000000000000000abc",
    deadline: DEADLINE,
    intents: [tokenDiff({ [USDT]: "999000", "nep141:wrap.near": "-1000000000000000000000000" })],
    nonce: NONCE,
  });
  const obj = JSON.parse(json);
  assert.deepEqual(Object.keys(obj), ["signer_id", "verifying_contract", "deadline", "nonce", "intents"]);
  assert.equal(obj.verifying_contract, INTENTS_CONTRACT_ID);
  assert.equal(obj.nonce, toBase64(NONCE));
});

test("intent constructors omit undefined optionals", () => {
  assert.deepEqual(transfer("m.near", { [USDT]: "1" }), {
    intent: "transfer",
    receiver_id: "m.near",
    tokens: { [USDT]: "1" },
  });
  assert.deepEqual(tokenDiff({ [USDT]: "1" }, { referral: "ref.near" }), {
    intent: "token_diff",
    diff: { [USDT]: "1" },
    referral: "ref.near",
  });
});

test("NEP-413 end-to-end: derive account, build reduced message, sign, verify", () => {
  const seed = new Uint8Array(32).fill(3);
  const signerId = ed25519ToAccountId(ed25519.getPublicKey(seed));
  const message = buildNep413MessageJson({
    signerId,
    deadline: DEADLINE,
    intents: [transfer("merchant.near", { [USDT]: "1000000" })],
    nonce: NONCE,
  });
  const mp = signNep413({ message, nonce: NONCE, recipient: INTENTS_CONTRACT_ID }, seed);
  assert.equal(verifyNep413(mp).valid, true);
  // The message JSON's signer_id equals the derived account id.
  assert.equal(JSON.parse(mp.payload.message).signer_id, signerId);
});

test("ERC-191 end-to-end: derive address, build full payload, sign, recover", () => {
  const sk = new Uint8Array(32).fill(4);
  const signerId = evmAddressFromSecpPublicKey(secp256k1.getPublicKey(sk, false));
  const payload = buildDefusePayloadJson({
    signerId,
    deadline: DEADLINE,
    intents: [transfer("merchant.near", { [USDT]: "1000000" })],
    nonce: NONCE,
  });
  const mp = signErc191(payload, sk);
  const res = verifyErc191(mp);
  assert.equal(res.valid, true);
  // The recovered address must equal the signer_id embedded in the payload.
  assert.equal(res.address, signerId);
  assert.equal(JSON.parse(mp.payload).signer_id, signerId);
});
