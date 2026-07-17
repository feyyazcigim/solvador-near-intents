import assert from "node:assert/strict";
import { test } from "node:test";
import { fromAtomicUnits, toAtomicUnits } from "../src/amounts.js";

test("toAtomicUnits handles whole, fractional, and exact-precision inputs", () => {
  assert.equal(toAtomicUnits("1", 6), 1_000_000n);
  assert.equal(toAtomicUnits("1.5", 6), 1_500_000n);
  assert.equal(toAtomicUnits("0.000001", 6), 1n);
  assert.equal(toAtomicUnits("1234.567890", 6), 1_234_567_890n);
  assert.equal(toAtomicUnits(2, 6), 2_000_000n);
  assert.equal(toAtomicUnits(5n, 6), 5n); // bigint is already atomic
});

test("toAtomicUnits rejects over-precise or malformed input", () => {
  assert.throws(() => toAtomicUnits("1.1234567", 6));
  assert.throws(() => toAtomicUnits("-1", 6));
  assert.throws(() => toAtomicUnits("abc", 6));
});

test("fromAtomicUnits trims trailing zeros and round-trips", () => {
  assert.equal(fromAtomicUnits(1_000_000n, 6), "1");
  assert.equal(fromAtomicUnits(1_500_000n, 6), "1.5");
  assert.equal(fromAtomicUnits(1n, 6), "0.000001");
  assert.equal(fromAtomicUnits(toAtomicUnits("1234.56789", 6), 6), "1234.56789");
});
