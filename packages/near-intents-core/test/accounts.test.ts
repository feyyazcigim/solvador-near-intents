import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyPair, keyToImplicitAddress } from "@near-js/crypto";
import {
  addressBytesFromAccountId,
  classifyAccountId,
  deriveIntentsAccountId,
  ed25519ToAccountId,
  evmAddressToAccountId,
  isEthImplicit,
} from "../src/accounts.js";

test("evmAddressToAccountId lowercases EIP-55 checksummed input", () => {
  assert.equal(
    evmAddressToAccountId("0xAbC0000000000000000000000000000000000ABC"),
    "0xabc0000000000000000000000000000000000abc",
  );
  assert.throws(() => evmAddressToAccountId("0x1234")); // too short
});

test("ed25519ToAccountId matches @near-js keyToImplicitAddress (the on-chain reference)", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const pk = kp.getPublicKey();
  assert.equal(ed25519ToAccountId(pk.toString()), keyToImplicitAddress(pk));
  assert.equal(ed25519ToAccountId(pk.data), keyToImplicitAddress(pk));
});

test("classifyAccountId distinguishes the three account kinds", () => {
  assert.equal(classifyAccountId("0xabc0000000000000000000000000000000000abc"), "eth-implicit");
  assert.equal(classifyAccountId("a".repeat(64)), "near-implicit");
  assert.equal(classifyAccountId("alice.near"), "named");
});

test("deriveIntentsAccountId dispatches on signer kind", () => {
  assert.equal(
    deriveIntentsAccountId({ kind: "evm", address: "0xABC0000000000000000000000000000000000abc" }),
    "0xabc0000000000000000000000000000000000abc",
  );
  assert.equal(deriveIntentsAccountId({ kind: "named", accountId: "bob.near" }), "bob.near");
});

test("ETH-implicit account id round-trips to 20 address bytes", () => {
  const id = "0xbff77166b39599e54e391156eef7b8191e02be92";
  assert.equal(isEthImplicit(id), true);
  assert.equal(addressBytesFromAccountId(id).length, 20);
});
