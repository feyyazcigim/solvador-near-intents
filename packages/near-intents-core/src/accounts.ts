/**
 * Derivation of NEAR Intents account ids ("signer_id") from external signer
 * identities.
 *
 * NEAR Intents identifies a signer by the NEAR AccountId it maps to. Three
 * account kinds matter here:
 *
 *  - **ETH-implicit** — a 42-char `0x` + 40-lowercase-hex string IS a valid
 *    NEAR account id. An EVM wallet that signs with ERC-191 is identified by
 *    its address, lowercased. (NEP-518 ETH-implicit accounts.)
 *  - **NEAR-implicit** — a 64-lowercase-hex string equal to the ed25519 public
 *    key bytes. A raw ed25519 / NEP-413 signer with no named account maps here.
 *  - **Named** — e.g. `alice.near`; passed through unchanged.
 *
 * The ed25519 → 64-hex mapping is cross-checked in a test against
 * `@near-js/crypto`'s `keyToImplicitAddress`, the on-chain reference.
 */
import { PublicKey } from "@near-js/crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { fromHex, keccak256, toHex } from "./bytes.js";

/** A 42-char lowercase `0x`-prefixed hex string (ETH-implicit account id). */
const ETH_IMPLICIT_RE = /^0x[0-9a-f]{40}$/;
/** A 64-char lowercase hex string (NEAR-implicit account id). */
const NEAR_IMPLICIT_RE = /^[0-9a-f]{64}$/;

/**
 * Normalize an EVM address to its NEAR ETH-implicit account id: lowercased,
 * `0x`-prefixed, validated as 20 bytes. Accepts EIP-55 checksummed input.
 *
 * @throws if the input is not a 20-byte hex address.
 */
export function evmAddressToAccountId(address: string): string {
  const lower = address.toLowerCase();
  if (!ETH_IMPLICIT_RE.test(lower)) {
    throw new Error(`Not a 20-byte EVM address: ${address}`);
  }
  return lower;
}

/**
 * Derive the EVM address (lowercase `0x`) from a secp256k1 public key.
 *
 * The address is `keccak256(X||Y)[12..32]` over the 64-byte uncompressed body —
 * exactly what the Verifier contract computes (`public_key.rs`), with NO
 * on-curve validation (so it reproduces the contract even for test fixtures).
 * Accepts a 64-byte raw `X||Y` key (NEAR's `secp256k1:` format), a 65-byte
 * `0x04||X||Y` SEC1 key, or a 33-byte compressed SEC1 key (decompressed first).
 */
export function evmAddressFromSecpPublicKey(publicKey: Uint8Array): string {
  let body: Uint8Array;
  if (publicKey.length === 64) {
    body = publicKey;
  } else if (publicKey.length === 65) {
    body = publicKey.subarray(1); // strip 0x04 SEC1 tag
  } else if (publicKey.length === 33) {
    body = secp256k1.Point.fromBytes(publicKey).toBytes(false).subarray(1); // decompress
  } else {
    throw new Error(`Unexpected secp256k1 public key length: ${publicKey.length}`);
  }
  return `0x${toHex(keccak256(body).subarray(12))}`;
}

/**
 * Derive the NEAR-implicit account id (64-hex) from an ed25519 public key.
 * Accepts raw 32 bytes or a canonical `ed25519:<base58>` string.
 *
 * @throws if the key is not 32 bytes.
 */
export function ed25519ToAccountId(publicKey: Uint8Array | string): string {
  const raw =
    typeof publicKey === "string" ? PublicKey.fromString(publicKey).data : publicKey;
  if (raw.length !== 32) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return toHex(raw);
}

/** Derive the NEAR-implicit account id (64-hex) from a 32-byte ed25519 seed. */
export function ed25519AccountIdFromSecretKey(secretKey: Uint8Array): string {
  return ed25519ToAccountId(ed25519.getPublicKey(secretKey));
}

/** The signer curve families this scheme understands. */
export type SignerIdentity =
  | { kind: "evm"; address: string }
  | { kind: "ed25519"; publicKey: Uint8Array | string }
  | { kind: "named"; accountId: string };

/**
 * Derive the NEAR Intents account id ("signer_id") for a signer identity.
 * This is the single source of truth used by both the client (to fill
 * `signer_id`) and the facilitator (to check the recovered signer matches).
 */
export function deriveIntentsAccountId(signer: SignerIdentity): string {
  switch (signer.kind) {
    case "evm":
      return evmAddressToAccountId(signer.address);
    case "ed25519":
      return ed25519ToAccountId(signer.publicKey);
    case "named":
      return signer.accountId;
  }
}

/** Classify an account id string by its NEAR account kind. */
export function classifyAccountId(
  accountId: string,
): "eth-implicit" | "near-implicit" | "named" {
  if (ETH_IMPLICIT_RE.test(accountId)) return "eth-implicit";
  if (NEAR_IMPLICIT_RE.test(accountId)) return "near-implicit";
  return "named";
}

/** True when `accountId` is a well-formed ETH-implicit (`0x` + 40-hex) id. */
export function isEthImplicit(accountId: string): boolean {
  return ETH_IMPLICIT_RE.test(accountId);
}

/** Recover the ETH-implicit account id from a hex/bytes 20-byte address input. */
export function accountIdFromAddressBytes(address20: Uint8Array): string {
  if (address20.length !== 20) throw new Error("address must be 20 bytes");
  return `0x${toHex(address20)}`;
}

/** Parse an ETH-implicit account id back to its 20 raw address bytes. */
export function addressBytesFromAccountId(accountId: string): Uint8Array {
  if (!ETH_IMPLICIT_RE.test(accountId)) {
    throw new Error(`Not an ETH-implicit account id: ${accountId}`);
  }
  return fromHex(accountId);
}
