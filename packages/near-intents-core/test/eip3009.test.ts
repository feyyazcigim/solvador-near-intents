import { strict as assert } from "node:assert";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  evmAddressFromSecpPublicKey,
  KNOWN_EIP3009_DOMAINS,
  parseOmftErc20,
  recoverTransferAuthorizationSigner,
  toHex,
  transferAuthorizationDigest,
  type TransferAuthorization,
} from "../src/index.js";

const DOMAIN = KNOWN_EIP3009_DOMAINS["8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]!;

const AUTH: Omit<TransferAuthorization, "signature"> = {
  from: "0xBfF7716648B7B693a2b1a8b7Ba2E966B6bA8bE92",
  to: "0x60b854981d8749a0F0E481E772dbA6082915C0d7",
  value: "10116",
  validAfter: "0",
  validBefore: "1784130000",
  nonce: `0x${"ab".repeat(32)}`,
};

test("digest is deterministic and depends on every field", () => {
  const d1 = transferAuthorizationDigest(DOMAIN, AUTH);
  const d2 = transferAuthorizationDigest(DOMAIN, AUTH);
  assert.equal(toHex(d1), toHex(d2));
  const d3 = transferAuthorizationDigest(DOMAIN, { ...AUTH, value: "10117" });
  assert.notEqual(toHex(d1), toHex(d3));
  const d4 = transferAuthorizationDigest({ ...DOMAIN, chainId: 1 }, AUTH);
  assert.notEqual(toHex(d1), toHex(d4));
});

test("sign → recover round-trips to the key's address (v ∈ {27,28} and {0,1})", () => {
  const secret = new Uint8Array(32).fill(7);
  const address = evmAddressFromSecpPublicKey(secp256k1.getPublicKey(secret, false));
  const auth = { ...AUTH, from: address };
  const digest = transferAuthorizationDigest(DOMAIN, auth);
  const sig = secp256k1.sign(digest, secret);
  const raw = new Uint8Array(65);
  raw.set(sig.toCompactRawBytes(), 0);

  for (const v of [sig.recovery, sig.recovery + 27]) {
    raw[64] = v;
    const recovered = recoverTransferAuthorizationSigner(DOMAIN, {
      ...auth,
      signature: `0x${toHex(raw)}`,
    });
    assert.equal(recovered, address);
  }
});

test("parseOmftErc20 extracts chain + token; rejects native/non-EVM", () => {
  assert.deepEqual(parseOmftErc20("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"), {
    chainId: 8453,
    tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  });
  assert.deepEqual(parseOmftErc20("nep141:eth-0x0000000000000000000000000000000000000001.omft.near"), {
    chainId: 1,
    tokenAddress: "0x0000000000000000000000000000000000000001",
  });
  assert.equal(parseOmftErc20("nep141:base.omft.near"), undefined); // native ETH
  assert.equal(parseOmftErc20("nep141:usdt.tether-token.near"), undefined);
  assert.equal(parseOmftErc20("nep141:sol-abc.omft.near"), undefined);
});
