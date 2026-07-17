/**
 * MultiPayload construction, signing, and verification for NEAR Intents.
 *
 * A MultiPayload is the signed envelope that `intents.near` (and the Solver
 * Relay / 1Click) accept. The inner `message` is a JSON string describing the
 * DefusePayload (signer_id, deadline, intents, …) — built in `intents.ts`.
 * This module owns the cryptography around that string:
 *
 *  - **NEP-413** (ed25519 wallets, and the ERC-191-free default for NEAR keys):
 *    digest = sha256( borsh(u32: 2^31+413) ++ borsh(Nep413Message) ), signed
 *    ed25519. Byte layout matches `@near-js/signers` `signNep413Message` and is
 *    cross-checked against it and the `borsh` package in tests.
 *  - **ERC-191** (`personal_sign`, EVM wallets): digest =
 *    keccak256("\x19Ethereum Signed Message:\n" + len + message), signed
 *    secp256k1; the signer is recovered from the signature.
 *
 * Signatures and public keys use NEAR's `<curve>:<base58>` string convention.
 * The 32-byte MultiPayload nonce is base64 on the wire.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { evmAddressFromSecpPublicKey } from "./accounts.js";
import { borshFixedBytes, borshOption, borshString, borshU32, concatBytes } from "./borsh.js";
import {
  fromBase58,
  fromBase64,
  fromHex,
  keccak256,
  sha256,
  toBase58,
  toBase64,
  utf8ToBytes,
} from "./bytes.js";

/** NEP-413 domain-separation tag: `2^31 + 413`, serialized as a Borsh u32 (LE). */
export const NEP413_PREFIX = 2_147_484_061;

/** Signing standards understood by the verifier contract. */
export type MultiPayloadStandard = "nep413" | "erc191" | "raw_ed25519";

/** NEP-413 MultiPayload (ed25519). `nonce` is base64 (32 bytes decoded). */
export type Nep413MultiPayload = {
  standard: "nep413";
  payload: {
    message: string;
    nonce: string; // base64, 32 bytes
    recipient: string;
    callback_url?: string;
  };
  public_key: string; // "ed25519:<base58>"
  signature: string; // "ed25519:<base58>"
};

/** ERC-191 MultiPayload (`personal_sign`). `payload` is the signed message string. */
export type Erc191MultiPayload = {
  standard: "erc191";
  payload: string;
  signature: string; // "secp256k1:<base58 of 65 bytes r||s||v>"
};

/** Raw ed25519 MultiPayload — signs the message bytes directly (no NEP-413 wrap). */
export type RawEd25519MultiPayload = {
  standard: "raw_ed25519";
  payload: string;
  public_key: string; // "ed25519:<base58>"
  signature: string; // "ed25519:<base58>"
};

export type MultiPayload = Nep413MultiPayload | Erc191MultiPayload | RawEd25519MultiPayload;

// ─────────────────────────────────────────────────────────────────────────────
// NEP-413
// ─────────────────────────────────────────────────────────────────────────────

/** Fields of a NEP-413 signed message. `nonce` is the raw 32 bytes. */
export type Nep413Message = {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
};

/**
 * Compute the 32-byte NEP-413 signing digest for a message.
 *
 * digest = sha256(
 *   borsh_u32(2^31+413)              // 4 bytes LE
 *   ++ borsh_string(message)          // u32 len + utf8
 *   ++ nonce                          // 32 raw bytes ([u8;32])
 *   ++ borsh_string(recipient)        // u32 len + utf8
 *   ++ borsh_option(callbackUrl)      // 0x00, or 0x01 ++ borsh_string
 * )
 */
export function nep413Digest(msg: Nep413Message): Uint8Array {
  if (msg.nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  const preimage = concatBytes(
    borshU32(NEP413_PREFIX),
    borshString(msg.message),
    borshFixedBytes(msg.nonce),
    borshString(msg.recipient),
    borshOption(msg.callbackUrl === undefined ? null : borshString(msg.callbackUrl)),
  );
  return sha256(preimage);
}

/** Sign a NEP-413 message with a raw 32-byte ed25519 secret key. */
export function signNep413(msg: Nep413Message, ed25519SecretKey: Uint8Array): Nep413MultiPayload {
  const digest = nep413Digest(msg);
  const signature = ed25519.sign(digest, ed25519SecretKey);
  const publicKey = ed25519.getPublicKey(ed25519SecretKey);
  return {
    standard: "nep413",
    payload: {
      message: msg.message,
      nonce: toBase64(msg.nonce),
      recipient: msg.recipient,
      ...(msg.callbackUrl === undefined ? {} : { callback_url: msg.callbackUrl }),
    },
    public_key: `ed25519:${toBase58(publicKey)}`,
    signature: `ed25519:${toBase58(signature)}`,
  };
}

/**
 * Verify a NEP-413 MultiPayload's signature against its embedded public key.
 * Returns the recovered `publicKey` (raw bytes) and canonical `ed25519:` string.
 * Fails closed (returns `valid: false`) on any decode/verify error.
 */
export function verifyNep413(mp: Nep413MultiPayload): {
  valid: boolean;
  publicKey?: Uint8Array;
  publicKeyString?: string;
} {
  try {
    const [curve, b58] = splitCurvePrefixed(mp.public_key);
    if (curve !== "ed25519") return { valid: false };
    const publicKey = fromBase58(b58);
    const [sigCurve, sigB58] = splitCurvePrefixed(mp.signature);
    if (sigCurve !== "ed25519") return { valid: false };
    const signature = fromBase58(sigB58);
    const digest = nep413Digest({
      message: mp.payload.message,
      nonce: fromBase64(mp.payload.nonce),
      recipient: mp.payload.recipient,
      ...(mp.payload.callback_url === undefined ? {} : { callbackUrl: mp.payload.callback_url }),
    });
    const valid = ed25519.verify(signature, digest, publicKey);
    return valid ? { valid, publicKey, publicKeyString: mp.public_key } : { valid: false };
  } catch {
    return { valid: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ERC-191 (personal_sign)
// ─────────────────────────────────────────────────────────────────────────────

/** Compute the 32-byte ERC-191 `personal_sign` digest for a UTF-8 message. */
export function erc191Digest(message: string): Uint8Array {
  const body = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`);
  return keccak256(concatBytes(prefix, body));
}

/**
 * Sign a message with ERC-191 `personal_sign` using a raw 32-byte secp256k1
 * secret key. The 65-byte signature is `r(32) ++ s(32) ++ v(1)` with `v` the
 * 0/1 recovery id (NOT 27/28), base58-encoded behind a `secp256k1:` prefix.
 */
export function signErc191(message: string, secpSecretKey: Uint8Array): Erc191MultiPayload {
  const digest = erc191Digest(message);
  const sig = secp256k1.sign(digest, secpSecretKey); // low-S by default (EIP-2)
  const raw = new Uint8Array(65);
  raw.set(sig.toCompactRawBytes(), 0);
  raw[64] = sig.recovery;
  return {
    standard: "erc191",
    payload: message,
    signature: `secp256k1:${toBase58(raw)}`,
  };
}

/**
 * Build an ERC-191 MultiPayload from a standard wallet `personal_sign` hex
 * signature (0x + 130 hex = 65 bytes). Normalizes Ethereum's `v` (27/28) to the
 * 0/1 recovery id the Verifier expects. This is the wallet-agnostic path: any
 * EVM wallet / viem / ethers `signMessage` output plugs in here.
 */
export function erc191MultiPayloadFromHexSig(message: string, hexSignature: string): Erc191MultiPayload {
  const raw = fromHex(hexSignature);
  if (raw.length !== 65) throw new Error(`personal_sign signature must be 65 bytes, got ${raw.length}`);
  let v = raw[64]!;
  if (v === 27 || v === 28) v -= 27; // Ethereum yParity → recovery id
  if (v !== 0 && v !== 1) throw new Error(`unexpected recovery byte ${raw[64]}`);
  const normalized = new Uint8Array(65);
  normalized.set(raw.subarray(0, 64), 0);
  normalized[64] = v;
  return { standard: "erc191", payload: message, signature: `secp256k1:${toBase58(normalized)}` };
}

/**
 * Recover the signer's lowercase `0x` address from an ERC-191 MultiPayload and
 * verify the signature. Also returns the recovered public key so a named-account
 * signer can be authorized via `has_public_key`. Fails closed on any error.
 */
export function verifyErc191(mp: Erc191MultiPayload): {
  valid: boolean;
  address?: string;
  /** Raw 64-byte X||Y public key. */
  publicKey?: Uint8Array;
  /** Canonical `secp256k1:<base58 64B>` string for `has_public_key`. */
  publicKeyString?: string;
} {
  try {
    const [curve, b58] = splitCurvePrefixed(mp.signature);
    if (curve !== "secp256k1") return { valid: false };
    const raw = fromBase58(b58);
    if (raw.length !== 65) return { valid: false };
    const v = raw[64];
    if (v !== 0 && v !== 1) return { valid: false };
    const digest = erc191Digest(mp.payload);
    const recovered = secp256k1.Signature.fromCompact(raw.subarray(0, 64))
      .addRecoveryBit(v)
      .recoverPublicKey(digest);
    // Re-verify the signature proper (recovery alone doesn't prove validity).
    const ok = secp256k1.verify(raw.subarray(0, 64), digest, recovered.toBytes(true));
    if (!ok) return { valid: false };
    const xy = recovered.toBytes(false).subarray(1); // strip 0x04 → 64-byte X||Y
    return {
      valid: true,
      address: evmAddressFromSecpPublicKey(xy),
      publicKey: xy,
      publicKeyString: `secp256k1:${toBase58(xy)}`,
    };
  } catch {
    return { valid: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// raw_ed25519
// ─────────────────────────────────────────────────────────────────────────────

/** Sign a message's UTF-8 bytes directly with ed25519 (no NEP-413 wrapper). */
export function signRawEd25519(message: string, ed25519SecretKey: Uint8Array): RawEd25519MultiPayload {
  const signature = ed25519.sign(utf8ToBytes(message), ed25519SecretKey);
  const publicKey = ed25519.getPublicKey(ed25519SecretKey);
  return {
    standard: "raw_ed25519",
    payload: message,
    public_key: `ed25519:${toBase58(publicKey)}`,
    signature: `ed25519:${toBase58(signature)}`,
  };
}

/** Verify a raw_ed25519 MultiPayload. Fails closed. */
export function verifyRawEd25519(mp: RawEd25519MultiPayload): {
  valid: boolean;
  publicKey?: Uint8Array;
} {
  try {
    const [curve, b58] = splitCurvePrefixed(mp.public_key);
    if (curve !== "ed25519") return { valid: false };
    const publicKey = fromBase58(b58);
    const [sigCurve, sigB58] = splitCurvePrefixed(mp.signature);
    if (sigCurve !== "ed25519") return { valid: false };
    const valid = ed25519.verify(fromBase58(sigB58), utf8ToBytes(mp.payload), publicKey);
    return valid ? { valid, publicKey } : { valid: false };
  } catch {
    return { valid: false };
  }
}

/** Split a `<curve>:<base58>` string into `[curve, base58]`. */
export function splitCurvePrefixed(value: string): [string, string] {
  const idx = value.indexOf(":");
  if (idx < 0) throw new Error(`Expected "<curve>:<data>", got ${value}`);
  return [value.slice(0, idx), value.slice(idx + 1)];
}
