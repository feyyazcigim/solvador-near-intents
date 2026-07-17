# Runbook — `near-intents-exact`

Operational playbook for the NEAR Intents scheme in the Solvador facilitator.

## Salt rotation

`intents.near` rotates its 4‑byte salt; versioned nonces embed it. The `SaltWatcher`
caches `current_salt` for 60s and advertises `saltExpiresAt` on issued nonces.

- **Symptom:** a burst of `STALE_SALT` verify/settle errors.
- **Expected:** these are *retriable*. The client SDK re‑requests the resource (fresh 402 →
  fresh nonce) and retries once. A brief blip around a rotation is normal.
- **If sustained:** the `is_valid_salt` grace window may have closed faster than the 60s cache.
  Lower `SaltWatcher` TTL (construct with `{ ttlMs }`) so issued nonces track rotations tighter.
  Confirm `current_salt` is reachable on the configured RPC.

## Relayer balance low

The relayer pays gas for every `execute_intents`. Reuses the **same** account/key as the
existing `@x402/near` delegate path, so the existing NEAR funding monitor already covers it.

- **Symptom:** `RELAYER_ERROR` on settle; `execute_intents` not landing.
- **Action:** top up `NEAR_ACCOUNT_ID`. Each settle costs ≤ 300 TGas; keep a NEAR buffer sized
  to peak settle rate. Multiple relayers can be configured (`relayers: [...]`) for
  load‑spreading and key rotation.

## `REFUNDED` / `FAILED` (confidential path)

1Click may `REFUND` or `FAIL` a confidential swap. `ConfidentialSettlement.settleByDeposit`
reports `success:false` for any non‑`SUCCESS` terminal status and still emits a signed‑status
receipt (the proof of what happened).

- **Action:** treat `REFUNDED`/`FAILED` as an unpaid resource — do **not** deliver. The receipt
  documents the outcome for support/dispute. The payer's funds were refunded to their
  `refundTo`.

## Solver‑quote starvation (Case B)

Solver Relay quotes are short‑lived and may be absent for thin pairs / tiny amounts.

- **Symptom:** `NoQuoteError` client‑side, or `QUOTE_EXPIRED` at settle.
- **Expected:** `QUOTE_EXPIRED` is *retriable* — the client re‑quotes (a shorter deadline
  generally prices better) and re‑signs. `NoQuoteError` means no solver covered the pair;
  fall back to Case A (pay in the merchant's token) or surface a deposit hint.
- **Floor:** document a Case B minimum amount; Case A has no solver dependency and is unaffected.

## Reconciliation (nightly)

Diff issued receipts against the chain to catch drift:

- **Public path:** for each settled `near-tx` receipt, re‑run `verifyNearTxReceipt` (or query
  the Intents Explorer API) and confirm the on‑chain transfer matches. Alert on any mismatch or
  missing tx. The `NonceStore` (status `settled`, with `transaction` + `receipt`) is the source
  of truth for what to reconcile.
- **Confidential path:** re‑poll `GET /v0/status` for stored deposit addresses and compare to the
  stored signed‑status payload; alert on divergence.

A `NonceStore.prune(now)` sweep should run on a timer to expire stale `issued` rows (TTL on
`deadline`); `settled` rows are retained for idempotency + reconciliation.

## Idempotency & double‑settle

Settlement is keyed on `(signer_id, nonce)`. A re‑settle of the same payment replays the cached
receipt (no second tx, no second billing row); a concurrent settle is rejected as in‑flight. The
on‑chain nonce bitmap is the ultimate backstop — a nonce can execute at most once regardless of
facilitator restarts.

## No testnet

NEAR Intents is mainnet‑only. Pre‑production = dust‑amount mainnet + `simulate_intents`
(gas‑free dry run). Cap CI/manual spend accordingly; `simulate_intents` in verify already catches
unbalanced intents before any gas is spent.
