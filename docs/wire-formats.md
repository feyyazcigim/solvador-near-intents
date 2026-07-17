# NEAR Intents wire formats — authoritative reference

Byte‑exact formats this monorepo implements, verified against primary sources (the
`near/intents` contract, `near-api-js`, and the official SDKs/docs). Every claim here is
exercised by a test; the golden vectors are copied verbatim from the contract repo.

## Signing standards & the MultiPayload envelope

`intents.near` accepts a `MultiPayload` tagged by `standard` (snake_case). We implement
`erc191`, `nep413`, and `raw_ed25519`.

```jsonc
// nep413 — ed25519 wallets. `message` is the REDUCED DefusePayload.
{
  "standard": "nep413",
  "payload": {
    "message": "{\"signer_id\":\"…\",\"deadline\":\"2026-…Z\",\"intents\":[…]}",
    "nonce": "<base64 of 32 bytes>",
    "recipient": "intents.near",
    "callbackUrl": "…"            // optional; omitted if absent
  },
  "public_key": "ed25519:<base58 32B>",
  "signature":  "ed25519:<base58 64B>"
}

// erc191 — EVM wallets (personal_sign). `payload` is the FULL DefusePayload string.
{
  "standard": "erc191",
  "payload": "{\"signer_id\":\"0x…\",\"verifying_contract\":\"intents.near\",\"deadline\":\"…Z\",\"nonce\":\"<base64 32B>\",\"intents\":[…]}",
  "signature": "secp256k1:<base58 of 65 bytes r‖s‖v>"   // NO public_key — recovered
}
```

Keys/signatures use `"<curve>:<base58>"`. The `nonce` inside a MultiPayload / DefusePayload
is **standard base64 (padded)**. The `secp256k1` recovery byte `v` is **0/1** (not 27/28).

### NEP‑413 digest (the #1 risk)

```
digest = sha256(
    borsh_u32(2147484061)          // 2^31 + 413, 4 bytes LE = 9d 01 00 80
  ++ borsh_string(message)          // u32 LE length + UTF‑8 bytes
  ++ nonce                          // 32 raw bytes ([u8;32], no length prefix)
  ++ borsh_string(recipient)        // u32 LE length + UTF‑8 bytes
  ++ borsh_option(callbackUrl)      // 0x00, or 0x01 ++ borsh_string
)
```

Then ed25519‑sign the 32‑byte digest. Schema field order is `message, nonce, recipient,
callbackUrl` (near‑api‑js `Nep413MessageSchema`). Golden vector (`crates/signatures/nep413`):
`message:"Hello, world!"`, `nonce:[0;32]`, `recipient:"intents.near"` →
digest `94648d71…031f59`, pubkey `e2e9cb7a…`, sig `e2ff6254…46b75d0f`.

### ERC‑191 prehash

`keccak256("\x19Ethereum Signed Message:\n" + decimal_ascii(len(msg)) + msg)`, then
secp256k1 recover. Golden vector (`crates/signatures/erc191`): `msg:"Hello world!"` →
prehash `aa05af77…199bcc`.

> **`borsh`‑JS caveat:** the `borsh` npm package length‑prefixes strings by UTF‑16
> code‑unit count and drops high bytes — wrong for non‑ASCII. The Rust contract uses
> UTF‑8. DefusePayload messages are ASCII JSON so this never bites in practice, but our
> `borshString` is UTF‑8 (correct against Rust), not a passthrough of the JS package.

## DefusePayload — the signed message body

`erc191` / `raw_ed25519` sign the **full** payload (struct order):

```json
{ "signer_id": "…", "verifying_contract": "intents.near", "deadline": "<RFC-3339>", "nonce": "<base64 32B>", "intents": [ … ] }
```

`nep413` signs the **reduced** `Nep413DefuseMessage` — `verifying_contract` comes from the
envelope `recipient`, `nonce` from the envelope `nonce`:

```json
{ "signer_id": "…", "deadline": "<RFC-3339>", "intents": [ … ] }
```

The contract verifies the signature over the **exact received bytes** then `serde_json`‑parses
(order/whitespace‑independent). So the object key order is a *client convention* (we fix it to
struct order); the only hard rule is **sign the exact bytes you submit** — guaranteed here
because each message string is built once and both signed and sent. `deadline` is an
ISO‑8601 / RFC‑3339 UTC string (a legacy `{"timestamp":…}` form exists in one old test vector;
current code uses the string).

## Account derivation (`signer_id`)

- **EVM** → the lowercase `0x`+40‑hex address = `keccak256(uncompressed_pubkey_64B)[12..32]`
  (a NEAR **ETH‑implicit** account id). Golden: `secp256k1:3aMVMx…` → `0xbff77166…be92`.
- **ed25519** → the 64‑hex of the 32 public‑key bytes (NEAR **implicit** account). Golden:
  `ed25519:5Tagut…` → `423df0a6…cc3a8e`. Cross‑checked against `@near-js` `keyToImplicitAddress`.
- **Named** (`alice.near`) → used as‑is; the recovered key must be registered via
  `has_public_key`.

## Intents

Amounts are decimal strings; token maps are `{ "<token_id>": "<amount>" }`.

```json
{ "intent": "transfer", "receiver_id": "merchant.near", "tokens": { "nep141:usdt.tether-token.near": "1000000" } }
{ "intent": "token_diff", "diff": { "nep141:wrap.near": "-1000000000000000000000000", "nep141:usdt.tether-token.near": "999000" } }
{ "intent": "ft_withdraw", "token": "usdt.tether-token.near", "receiver_id": "bob.near", "amount": "1000000" }
{ "intent": "native_withdraw", "receiver_id": "bob.near", "amount": "1000000000000000000000000" }
```

`token_diff.diff`: negative = spent (in), positive = received (out); protocol fee taken from
the negatives.

## Token ids

`nep141:<contract>` · `nep171:<contract>:<id>` · `nep245:<contract>:<id>`. Canonical mainnet
tokens: USDC `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (6 dp —
**not** `usdc.near`), USDT `nep141:usdt.tether-token.near`, wNEAR `nep141:wrap.near`.

## `intents.near` methods

- `execute_intents({ signed: MultiPayload[] })` — change method, no deposit (relayer submits).
- `simulate_intents({ signed }) -> SimulationOutput` — `&self` view (call via RPC
  `call_function`); `invariant_violated` present ⇒ the intent set doesn't balance.
- `mt_batch_balance_of({ account_id, token_ids }) -> U128[]` (decimal strings).
- `is_nonce_used({ account_id, nonce }) -> bool` — `nonce` is base64.
- `has_public_key({ account_id, public_key }) -> bool`.
- `current_salt() -> Salt` (4‑byte hex, e.g. `"a1b2c3d4"`); `is_valid_salt({ salt }) -> bool`.

## Nonces

32‑byte value in a per‑account bitmap. Two encodings:

- **Legacy** — 32 random bytes (still accepted; being deprecated).
- **Versioned V1** (recommended) — `56 28 f6 c6` (magic) `‖ 00` (version) `‖ salt[4]`
  `‖ deadline_i64_nanoseconds` (LE, 8 bytes) `‖ random[15]`, base64‑encoded. Embeds the current
  salt (from `current_salt`) and a deadline so rotated/expired nonces are rejected cheaply.

## 1Click (confidential) & Solver Relay (Case B)

- **1Click** `https://1click.chaindefuser.com`, `Authorization: Bearer <JWT>` (removes the
  0.2% fee; unlocks `confidentiality: "basic"|"advanced"`). `GET /v0/tokens`, `POST /v0/quote`,
  `GET /v0/status?depositAddress=…` (statuses `KNOWN_DEPOSIT_TX, PENDING_DEPOSIT,
  INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED`), `POST /v0/deposit/submit`,
  `POST /v0/auth/authenticate`.
- **Solver Relay** `https://solver-relay-v2.chaindefuser.com/rpc` (JSON‑RPC, `X-API-Key`):
  `quote` → offers with `quote_hash`; `publish_intent({ quote_hashes, signed_data })`; `get_status`
  (statuses `PENDING, TX_BROADCASTED, SETTLED, NOT_FOUND_OR_NOT_VALID`; `data.hash` = settling tx).

## Sources

`github.com/near/intents` (`contracts/defuse/core/src/payload/*`, `crates/signatures/{nep413,erc191}`,
`crates/crypto/src/*`, `intents/mod.rs`, `nonce/*`, `salts.rs`, `public_key.rs`,
`simulation_output.rs`) · `github.com/near/near-api-js` (`src/nep413/schema.ts`) ·
NEP‑413 / NEP‑461 specs · `docs.near-intents.org` (1Click, Solver Relay, simulating‑intents) ·
`github.com/defuse-protocol/one-click-sdk-typescript`.
