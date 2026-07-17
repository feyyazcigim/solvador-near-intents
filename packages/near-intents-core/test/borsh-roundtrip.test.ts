import assert from "node:assert/strict";
import { test } from "node:test";
import { serialize } from "borsh";
import { borshFixedBytes, borshOption, borshString, borshU32, concatBytes } from "../src/borsh.js";

// Cross-check each hand-rolled Borsh primitive against the `borsh` npm package
// (the same library the on-chain-referenced near-js uses), so a byte drift here
// can't slip through unnoticed.

test("borshU32 matches borsh.serialize('u32')", () => {
  for (const n of [0, 1, 413, 2_147_484_061, 0xff_ff_ff_ff]) {
    assert.deepEqual(borshU32(n), new Uint8Array(serialize("u32", n)));
  }
});

test("borshString matches borsh.serialize('string') for ASCII (the real-world case)", () => {
  // DefusePayload messages are ASCII JSON, so this is the case that matters.
  for (const s of ["", "intents.near", "Hello, world!", '{"signer_id":"alice.near"}']) {
    assert.deepEqual(borshString(s), new Uint8Array(serialize("string", s)));
  }
});

test("borshString is proper UTF-8 (matches the Rust contract, not the borsh-JS quirk)", () => {
  // The `borsh` npm package length-prefixes strings by UTF-16 code-unit count
  // and drops high bytes; the Rust contract (and thus signature verification)
  // uses UTF-8. Ours must match Rust: byte-length prefix + exact UTF-8 bytes.
  const s = "ü🌍";
  const utf8 = new TextEncoder().encode(s); // 2 + 4 = 6 bytes
  const out = borshString(s);
  assert.deepEqual(out.subarray(0, 4), borshU32(utf8.length));
  assert.deepEqual(out.subarray(4), utf8);
});

test("borshFixedBytes matches borsh [u8; N] with no length prefix", () => {
  const bytes = new Uint8Array(32).map((_, i) => i);
  assert.deepEqual(
    borshFixedBytes(bytes),
    new Uint8Array(serialize({ array: { type: "u8", len: 32 } }, bytes)),
  );
});

test("borshOption matches borsh Option<string> for Some and None", () => {
  assert.deepEqual(borshOption(null), new Uint8Array(serialize({ option: "string" }, null)));
  assert.deepEqual(
    borshOption(borshString("cb")),
    new Uint8Array(serialize({ option: "string" }, "cb")),
  );
});

test("concatBytes concatenates in order", () => {
  assert.deepEqual(
    concatBytes(Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5)),
    Uint8Array.of(1, 2, 3, 4, 5),
  );
});
