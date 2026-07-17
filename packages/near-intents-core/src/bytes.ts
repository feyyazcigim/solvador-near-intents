/**
 * Byte / string / base-N encoding helpers, plus the two hash functions this
 * codebase needs. Thin, dependency-explicit wrappers so every call site reads
 * the same way and the encoding is never ambiguous.
 *
 *  - hex is ALWAYS lowercase, no `0x` prefix (NEAR implicit-account convention)
 *  - base58 for NEAR `ed25519:`/`secp256k1:` key + signature payloads
 *  - base64 (standard, with padding) for the 32-byte MultiPayload nonce
 */
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes as nobleHexToBytes } from "@noble/hashes/utils";
import { base58, base64 } from "@scure/base";

export { concatBytes } from "./borsh.js";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** UTF-8 encode a string to bytes. */
export function utf8ToBytes(value: string): Uint8Array {
  return utf8Encoder.encode(value);
}

/** UTF-8 decode bytes to a string. */
export function bytesToUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/** Lowercase hex (no `0x`). */
export function toHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

/** Parse hex (with or without a leading `0x`) into bytes. */
export function fromHex(hex: string): Uint8Array {
  return nobleHexToBytes(hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex);
}

/** Base58 encode (Bitcoin alphabet), used for NEAR key/signature suffixes. */
export function toBase58(bytes: Uint8Array): string {
  return base58.encode(bytes);
}

/** Base58 decode. */
export function fromBase58(value: string): Uint8Array {
  return base58.decode(value);
}

/** Standard base64 with padding — the MultiPayload nonce encoding. */
export function toBase64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

/** Decode standard base64 (padded). */
export function fromBase64(value: string): Uint8Array {
  return base64.decode(value);
}

/** SHA-256 digest (32 bytes). */
export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

/** keccak-256 digest (32 bytes) — Ethereum's hash, used by ERC-191. */
export function keccak256(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes);
}
