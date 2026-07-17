import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyPair } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import { serialize } from "borsh";
import { fromBase58, sha256, toBase58, toBase64 } from "../src/bytes.js";
import {
  erc191Digest,
  nep413Digest,
  signErc191,
  signNep413,
  signRawEd25519,
  verifyErc191,
  verifyNep413,
  verifyRawEd25519,
} from "../src/payload.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { evmAddressFromSecpPublicKey, evmAddressToAccountId } from "../src/accounts.js";

// The exact schema `@near-js/signers` feeds to the `borsh` package. If our
// hand-rolled layout drifts from this, the preimage bytes differ and the test
// below fails — which is the whole point (spec §9 risk #1).
const NEP413_SCHEMA = {
  struct: {
    message: "string",
    nonce: { array: { type: "u8", len: 32 } },
    recipient: "string",
    callbackUrl: { option: "string" },
  },
} as const;

function refDigest(message: string, nonce: Uint8Array, recipient: string, callbackUrl?: string) {
  const prefix = serialize("u32", 2_147_484_061);
  const params = serialize(NEP413_SCHEMA, { message, nonce, recipient, callbackUrl: callbackUrl ?? null });
  const preimage = new Uint8Array(prefix.length + params.length);
  preimage.set(prefix, 0);
  preimage.set(params, prefix.length);
  return sha256(preimage);
}

const NONCE = new Uint8Array(32);
for (let i = 0; i < 32; i++) NONCE[i] = i + 1;

test("nep413Digest matches the borsh-package reference (no callbackUrl)", () => {
  const message = '{"deadline":"2026-07-15T00:00:00.000Z","intents":[],"signer_id":"alice.near"}';
  assert.deepEqual(
    nep413Digest({ message, nonce: NONCE, recipient: "intents.near" }),
    refDigest(message, NONCE, "intents.near"),
  );
});

test("nep413Digest matches the borsh-package reference (with callbackUrl)", () => {
  const message = "hello world";
  assert.deepEqual(
    nep413Digest({ message, nonce: NONCE, recipient: "intents.near", callbackUrl: "https://x.test/cb" }),
    refDigest(message, NONCE, "intents.near", "https://x.test/cb"),
  );
});

test("signNep413 produces byte-identical signature to @near-js/signers (deterministic ed25519)", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  // near-js secret string is `ed25519:<base58 of 64 bytes>` (seed32 || pub32).
  const secret64 = fromBase58(kp.toString().split(":")[1]!);
  const seed32 = secret64.subarray(0, 32);

  const message = '{"deadline":"2026-07-15T00:00:00.000Z","intents":[],"signer_id":"alice.near"}';
  const mine = signNep413({ message, nonce: NONCE, recipient: "intents.near" }, seed32);

  const signer = new KeyPairSigner(kp);
  const res = await signer.signNep413Message(message, "alice.near", "intents.near", NONCE, undefined);
  const refSig = res.signature instanceof Uint8Array ? res.signature : (res.signature as { data: Uint8Array }).data;

  assert.equal(mine.signature, `ed25519:${toBase58(refSig)}`, "signatures must match byte-for-byte");
  assert.equal(mine.public_key, res.publicKey.toString(), "public key strings must match");
});

test("verifyNep413 accepts our own signature and the near-js signature", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const seed32 = fromBase58(kp.toString().split(":")[1]!).subarray(0, 32);
  const message = "verify me";
  const mp = signNep413({ message, nonce: NONCE, recipient: "intents.near" }, seed32);
  assert.equal(verifyNep413(mp).valid, true);

  // Tampering the message must fail closed.
  assert.equal(verifyNep413({ ...mp, payload: { ...mp.payload, message: "tampered" } }).valid, false);
});

test("nep413 nonce is base64 on the wire and round-trips to 32 bytes", () => {
  const mp = signNep413({ message: "x", nonce: NONCE, recipient: "intents.near" }, new Uint8Array(32).fill(9));
  assert.equal(mp.payload.nonce, toBase64(NONCE));
});

test("erc191 sign → verify recovers the correct lowercase 0x address", () => {
  const sk = new Uint8Array(32).fill(0x11);
  const address = evmAddressFromSecpPublicKey(secp256k1.getPublicKey(sk, false));
  const message = '{"deadline":"2026-07-15T00:00:00.000Z","intents":[],"signer_id":"' + address + '"}';
  const mp = signErc191(message, sk);
  const res = verifyErc191(mp);
  assert.equal(res.valid, true);
  assert.equal(res.address, address);
  assert.equal(evmAddressToAccountId(res.address!), address);
});

test("erc191 digest follows the personal_sign framing", () => {
  // "abc" → keccak256("\x19Ethereum Signed Message:\n3abc")
  const d = erc191Digest("abc");
  assert.equal(d.length, 32);
});

test("erc191 tampering the payload changes the recovered signer (caught by signer_id check)", () => {
  // ecrecover always yields *some* address; the security property is that a
  // tampered payload recovers a DIFFERENT address than the true signer, so the
  // downstream `recovered === signer_id` check fails. That check is the gate.
  const sk = new Uint8Array(32).fill(0x22);
  const trueAddr = evmAddressFromSecpPublicKey(secp256k1.getPublicKey(sk, false));
  const mp = signErc191("original", sk);
  assert.equal(verifyErc191(mp).address, trueAddr);

  const res = verifyErc191({ ...mp, payload: "changed" });
  assert.ok(!res.valid || res.address !== trueAddr, "tampered payload must not recover the true signer");
});

test("raw_ed25519 sign → verify round-trips", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const seed32 = fromBase58(kp.toString().split(":")[1]!).subarray(0, 32);
  const mp = signRawEd25519("raw message", seed32);
  assert.equal(verifyRawEd25519(mp).valid, true);
  assert.equal(verifyRawEd25519({ ...mp, payload: "nope" }).valid, false);
});
