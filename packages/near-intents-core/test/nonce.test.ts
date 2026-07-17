import assert from "node:assert/strict";
import { test } from "node:test";
import { fromHex } from "../src/bytes.js";
import {
  decodeVersionedNonce,
  encodeVersionedNonce,
  isVersionedNonce,
  randomNonce,
  VERSIONED_NONCE_MAGIC,
} from "../src/nonce.js";

const SALT = "a1b2c3d4";
const DEADLINE = new Date("2026-07-15T00:00:00.000Z");
const RANDOM = new Uint8Array(15).fill(7);

test("encodeVersionedNonce lays out magic || version || salt || deadline(LE i64) || random", () => {
  const n = encodeVersionedNonce({ salt: SALT, deadline: DEADLINE, random: RANDOM });
  assert.equal(n.length, 32);
  assert.deepEqual(n.subarray(0, 4), VERSIONED_NONCE_MAGIC);
  assert.equal(n[4], 0x00); // V1 discriminant
  assert.deepEqual(n.subarray(5, 9), fromHex(SALT));
  const deadlineNs = new DataView(n.buffer, n.byteOffset).getBigInt64(9, true);
  assert.equal(deadlineNs, BigInt(DEADLINE.getTime()) * 1_000_000n);
  assert.deepEqual(n.subarray(17, 32), RANDOM);
});

test("decodeVersionedNonce round-trips the encoded fields", () => {
  const n = encodeVersionedNonce({ salt: SALT, deadline: DEADLINE, random: RANDOM });
  const d = decodeVersionedNonce(n);
  assert.ok(d);
  assert.equal(d.saltHex, SALT);
  assert.equal(d.deadlineNanos, BigInt(DEADLINE.getTime()) * 1_000_000n);
  assert.equal(d.deadline.toISOString(), DEADLINE.toISOString());
  assert.deepEqual(d.random, RANDOM);
});

test("isVersionedNonce distinguishes versioned from legacy random nonces", () => {
  assert.equal(isVersionedNonce(encodeVersionedNonce({ salt: SALT, deadline: DEADLINE })), true);
  const legacy = randomNonce();
  assert.equal(legacy.length, 32);
  // A legacy random nonce carrying the 5-byte magic prefix is ~1 in 2^40; treat
  // as effectively never.
  assert.equal(isVersionedNonce(legacy), false);
});

test("decodeVersionedNonce returns null for non-versioned input", () => {
  assert.equal(decodeVersionedNonce(new Uint8Array(32)), null);
  assert.equal(decodeVersionedNonce(new Uint8Array(10)), null);
});

test("parseSalt rejects wrong-length salts", () => {
  assert.throws(() => encodeVersionedNonce({ salt: "a1b2", deadline: DEADLINE }));
});
