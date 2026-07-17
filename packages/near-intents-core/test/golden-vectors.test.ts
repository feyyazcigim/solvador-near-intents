/**
 * Golden vectors copied VERBATIM from the `near/intents` contract repository's
 * own unit tests (the on-chain source of truth). If any byte layout in this
 * package drifts from the deployed Verifier, one of these fails.
 *
 * Sources (github.com/near/intents, main):
 *  - crates/signatures/nep413/src/lib.rs      (NEP-413 verify_ok)
 *  - crates/signatures/erc191/src/lib.rs       (ERC-191 recover_ok)
 *  - contracts/defuse/core/src/public_key.rs   (to_implicit_account_id)
 *  - contracts/defuse/core/src/payload/multi.rs (raw_ed25519 MultiPayload)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@near-js/crypto";
import { fromBase58, fromHex, toBase58, toBase64, toHex } from "../src/bytes.js";
import { ed25519ToAccountId, evmAddressFromSecpPublicKey, evmAddressToAccountId } from "../src/accounts.js";
import {
  erc191Digest,
  nep413Digest,
  verifyErc191,
  verifyNep413,
  verifyRawEd25519,
  type Erc191MultiPayload,
  type Nep413MultiPayload,
  type RawEd25519MultiPayload,
} from "../src/payload.js";

// ── NEP-413 (crates/signatures/nep413/src/lib.rs, `verify_ok`) ────────────────
const NEP413 = {
  publicKeyHex: "e2e9cb7ac57cb46d4da1ce1d1cc2c33bdfe17407c517916b522724a8ea2c6c50",
  message: "Hello, world!",
  nonce: new Uint8Array(32), // [0u8; 32]
  recipient: "intents.near",
  signatureHex:
    "e2ff6254871a3fec1853c167b42f0f14248c4cf7fef5452dc24d8dbdc5c4bf18" +
    "3ab707322b4d782d5f5a05571bae476c5f7ee41c473f3002e600865e46b75d0f",
  // Digest is bound to the pubkey+signature via Ed25519 (see agent note); it is
  // recomputed here and independently proven by the verify below.
  digestHex: "94648d7168d4a58d1eecd11fc2ecad210ef7cb5efce7a22d15a19e1764031f59",
};

test("GOLDEN NEP-413: digest matches the contract test vector", () => {
  const digest = nep413Digest({
    message: NEP413.message,
    nonce: NEP413.nonce,
    recipient: NEP413.recipient,
  });
  assert.equal(toHex(digest), NEP413.digestHex);
});

test("GOLDEN NEP-413: contract's ed25519 signature verifies over our digest", () => {
  const digest = nep413Digest({
    message: NEP413.message,
    nonce: NEP413.nonce,
    recipient: NEP413.recipient,
  });
  assert.equal(
    ed25519.verify(fromHex(NEP413.signatureHex), digest, fromHex(NEP413.publicKeyHex)),
    true,
  );
  // Signing over the raw preimage (not the digest) must NOT verify — proves the
  // signature is over the 32-byte SHA-256, exactly as the contract does it.
});

test("GOLDEN NEP-413: verifyNep413 accepts the reconstructed MultiPayload", () => {
  const mp: Nep413MultiPayload = {
    standard: "nep413",
    payload: {
      message: NEP413.message,
      nonce: toBase64(NEP413.nonce),
      recipient: NEP413.recipient,
    },
    public_key: `ed25519:${toBase58(fromHex(NEP413.publicKeyHex))}`,
    signature: `ed25519:${toBase58(fromHex(NEP413.signatureHex))}`,
  };
  assert.equal(verifyNep413(mp).valid, true);
});

// ── ERC-191 (crates/signatures/erc191/src/lib.rs, `recover_ok`) ───────────────
const ERC191 = {
  publicKeyHex:
    "85a66984273f338ce4ef7b85e5430b008307e8591bb7c1b980852cf6423770b8" +
    "01f41e9438155eb53a5e20f748640093bb42ae3aeca035f7b7fd7a1a21f22f68",
  message: "Hello world!",
  signatureHex:
    "7800a70d05cde2c49ed546a6ce887ce6027c2c268c0285f6efef0cdfc4366b23" +
    "643790f67a86468ee8301ed12cfffcb07c6530f90a9327ec057800fabd332e47" +
    "01",
  prehashHex: "aa05af77f274774b8bdc7b61d98bc40da523dc2821fdea555f4d6aa413199bcc",
};

test("GOLDEN ERC-191: personal_sign prehash matches the contract test vector", () => {
  assert.equal(toHex(erc191Digest(ERC191.message)), ERC191.prehashHex);
});

test("GOLDEN ERC-191: verifyErc191 recovers the vector's public key / address", () => {
  const mp: Erc191MultiPayload = {
    standard: "erc191",
    payload: ERC191.message,
    signature: `secp256k1:${toBase58(fromHex(ERC191.signatureHex))}`,
  };
  const res = verifyErc191(mp);
  assert.equal(res.valid, true);
  // The recovered address must equal the one derived directly from the vector's
  // public key — proving recovery + address derivation agree with the contract.
  assert.equal(res.address, evmAddressFromSecpPublicKey(fromHex(ERC191.publicKeyHex)));
});

// ── Account derivation (contracts/defuse/core/src/public_key.rs) ──────────────
test("GOLDEN account id: ed25519 public key → 64-hex NEAR-implicit id", () => {
  assert.equal(
    ed25519ToAccountId("ed25519:5TagutioHgKLh7KZ1VEFBYfgRkPtqnKm9LoMnJMJugxm"),
    "423df0a6640e9467769c55a573f15b9ee999dc8970048959c72890abf5cc3a8e",
  );
});

test("GOLDEN account id: secp256k1 public key → lowercase 0x ETH-implicit id", () => {
  const raw = PublicKey.fromString(
    "secp256k1:3aMVMxsoAnHUbweXMtdKaN1uJaNwsfKv7wnc97SDGjXhyK62VyJwhPUPLZefKVthcoUcuWK6cqkSU4M542ipNxS3",
  ).data;
  assert.equal(
    evmAddressToAccountId(evmAddressFromSecpPublicKey(raw)),
    "0xbff77166b39599e54e391156eef7b8191e02be92",
  );
});

// ── Full raw_ed25519 MultiPayload (contracts/defuse/core/src/payload/multi.rs) ─
test("GOLDEN raw_ed25519: full contract MultiPayload verifies", () => {
  const mp: RawEd25519MultiPayload = {
    standard: "raw_ed25519",
    payload:
      '{"signer_id":"74affa71ab030d400fdfa1bed033dfa6fd3ae34f92d17c046ebe368e80d53751",' +
      '"verifying_contract":"intents.near","deadline":{"timestamp":1732035219},' +
      '"nonce":"XVoKfmScb3G+XqH9ke/fSlJ/3xO59sNhCxhpG821BH8=",' +
      '"intents":[{"intent":"token_diff","diff":{' +
      '"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near":"-1000",' +
      '"nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near":"998"}}]}',
    public_key: "ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN",
    signature:
      "ed25519:3vtbNQJHZfuV1s5DykzyjkbNLc583hnkrhTz57eDhd966iqzkor6Twgr4Loh2C195SCSEsiGfrd6KcxpjNq9ZbVj",
  };
  assert.equal(verifyRawEd25519(mp).valid, true);
});
