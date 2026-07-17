/**
 * Defuse nonces.
 *
 * A nonce is a 32-byte value committed permit2-style into a per-account bitmap;
 * `is_nonce_used(account_id, nonce)` reports whether it's spent. Two encodings:
 *
 *  - **legacy** — 32 random bytes. Still accepted, but the Verifier source says
 *    it "will be prohibited in the near future". Kept as a fallback only.
 *  - **versioned V1** (recommended) — embeds the current salt and a deadline so
 *    the contract can reject rotated-salt or expired nonces cheaply. Byte layout
 *    (confirmed against `contracts/defuse/core/src/nonce/` in `near/intents`):
 *
 *        MAGIC(4) = 56 28 f6 c6
 *      ‖ VERSION(1) = 00                 (Borsh enum discriminant for V1)
 *      ‖ SALT(4)                          (from `current_salt`)
 *      ‖ DEADLINE(8)                      (i64 nanoseconds since epoch, LE)
 *      ‖ RANDOM(15)
 *        = 32 bytes, base64 on the wire.
 */
import { fromHex, toHex } from "./bytes.js";

/** `hex!("5628f6c6")` — the versioned-nonce magic prefix. */
export const VERSIONED_NONCE_MAGIC = Uint8Array.of(0x56, 0x28, 0xf6, 0xc6);
/** Borsh enum discriminant for the V1 versioned nonce. */
export const VERSIONED_NONCE_V1 = 0x00;

/** Generate a legacy 32-byte random nonce. */
export function randomNonce(): Uint8Array {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return out;
}

/** Parse a 4-byte salt from a hex string (e.g. `"a1b2c3d4"`) or raw bytes. */
export function parseSalt(salt: string | Uint8Array): Uint8Array {
  const bytes = typeof salt === "string" ? fromHex(salt) : salt;
  if (bytes.length !== 4) throw new Error(`salt must be 4 bytes, got ${bytes.length}`);
  return bytes;
}

/** Convert a deadline (Date | epoch-ms number | epoch-ns bigint) to ns bigint. */
export function deadlineToNanos(deadline: Date | number | bigint): bigint {
  if (typeof deadline === "bigint") return deadline;
  const ms = typeof deadline === "number" ? deadline : deadline.getTime();
  return BigInt(Math.floor(ms)) * 1_000_000n;
}

export type VersionedNonceInput = {
  salt: string | Uint8Array;
  deadline: Date | number | bigint;
  /** 15 random bytes; generated if omitted. */
  random?: Uint8Array;
};

/** Encode a versioned V1 nonce (32 bytes). */
export function encodeVersionedNonce(input: VersionedNonceInput): Uint8Array {
  const salt = parseSalt(input.salt);
  const random = input.random ?? randomBytes(15);
  if (random.length !== 15) throw new Error(`random must be 15 bytes, got ${random.length}`);

  const out = new Uint8Array(32);
  out.set(VERSIONED_NONCE_MAGIC, 0); // [0,4)
  out[4] = VERSIONED_NONCE_V1; // [4]
  out.set(salt, 5); // [5,9)
  new DataView(out.buffer).setBigInt64(9, deadlineToNanos(input.deadline), /* LE */ true); // [9,17)
  out.set(random, 17); // [17,32)
  return out;
}

export type DecodedVersionedNonce = {
  salt: Uint8Array;
  saltHex: string;
  deadlineNanos: bigint;
  deadline: Date;
  random: Uint8Array;
};

/** Decode a versioned V1 nonce, or return `null` if it isn't one. */
export function decodeVersionedNonce(nonce: Uint8Array): DecodedVersionedNonce | null {
  if (nonce.length !== 32) return null;
  for (let i = 0; i < 4; i++) if (nonce[i] !== VERSIONED_NONCE_MAGIC[i]) return null;
  if (nonce[4] !== VERSIONED_NONCE_V1) return null;
  const salt = nonce.slice(5, 9);
  const deadlineNanos = new DataView(nonce.buffer, nonce.byteOffset).getBigInt64(9, true);
  return {
    salt,
    saltHex: toHex(salt),
    deadlineNanos,
    deadline: new Date(Number(deadlineNanos / 1_000_000n)),
    random: nonce.slice(17, 32),
  };
}

/** True if `nonce` carries the versioned magic prefix. */
export function isVersionedNonce(nonce: Uint8Array): boolean {
  if (nonce.length !== 32) return false;
  for (let i = 0; i < 4; i++) if (nonce[i] !== VERSIONED_NONCE_MAGIC[i]) return false;
  return nonce[4] === VERSIONED_NONCE_V1;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}
