/**
 * Minimal Borsh serialization primitives — just enough to build the NEP-413
 * signing preimage byte-for-byte.
 *
 * We hand-roll these (rather than pull a schema library) for two reasons:
 *  1. The NEP-413 digest is the single highest-risk byte layout in this codebase
 *     (spec §9 risk table): one wrong byte and every signature fails *silently*
 *     at the contract. Explicit, auditable serializers make the layout obvious.
 *  2. No runtime dependency on a Borsh schema DSL for a 4-field struct.
 *
 * Borsh spec (https://borsh.io): integers are little-endian and fixed-width;
 * a `string` is `u32` byte-length (LE) followed by its UTF-8 bytes; a fixed
 * `[u8; N]` array is N raw bytes with NO length prefix; an `Option<T>` is a
 * single tag byte (0 = None, 1 = Some) followed by T's encoding when Some.
 *
 * A `borsh-roundtrip.test.ts` cross-checks every primitive here against the
 * `borsh` npm package so a regression can't drift the bytes unnoticed.
 */

const textEncoder = new TextEncoder();

/** Serialize a `u32` as 4 little-endian bytes. */
export function borshU32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff_ff_ff_ff) {
    throw new RangeError(`borshU32: ${value} is not a u32`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, /* littleEndian */ true);
  return out;
}

/** Serialize a Borsh `string`: `u32` LE length prefix, then UTF-8 bytes. */
export function borshString(value: string): Uint8Array {
  const bytes = textEncoder.encode(value);
  return concatBytes(borshU32(bytes.length), bytes);
}

/**
 * Serialize a fixed-size byte array (`[u8; N]`): the raw bytes, with NO length
 * prefix. Used for the NEP-413 32-byte nonce.
 */
export function borshFixedBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

/**
 * Serialize an `Option<T>`: tag byte `0x00` for `None`, or `0x01` followed by
 * the already-encoded `Some` value.
 */
export function borshOption(value: Uint8Array | null | undefined): Uint8Array {
  if (value === null || value === undefined) return Uint8Array.of(0);
  return concatBytes(Uint8Array.of(1), value);
}

/** Concatenate byte chunks into one contiguous Uint8Array. */
export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
