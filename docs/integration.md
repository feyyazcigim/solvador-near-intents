# Solvador integration

How `near-intents-exact` wires into the Solvador facilitator. Done on the
**`feat/near-intents-exact`** branch of the `solvador` repo — a minimal, flag‑gated,
non‑breaking touch (Solvador's 57 existing tests pass unchanged with the flag off).

## What changed in `solvador`

1. **`package.json`** — two `file:` dependencies (facilitator + its `core` dep, so npm resolves
   the workspace `*` transitive locally):
   ```jsonc
   "@solvador/near-intents-core": "file:../../near-intents/packages/near-intents-core",
   "@solvador/near-intents-facilitator": "file:../../near-intents/packages/near-intents-facilitator",
   ```
   (Assumes this monorepo sits at `../../near-intents` relative to `solvador/`. Both run via
   `tsx`, so the packages are consumed as TypeScript source — no build step.)

2. **`src/facilitator/facilitator.ts`** — after the existing `ExactNearScheme` registration,
   an opt‑in block calls `registerNearIntents(baseFacilitator, …)` reusing the **same**
   `NEAR_ACCOUNT_ID` / `NEAR_PRIVATE_KEY`, and exports `nearIntentsNonceHandler` / `nearIntentsNoncePath`.

3. **`src/facilitator/routes.ts`** — mounts `GET /schemes/near-intents-exact/nonce` when the
   handler is present.

4. **`.env.example`** — the new toggles (below).

## Environment

| Var | Purpose |
|---|---|
| `NEAR_INTENTS_EXACT=1` | Advertise + settle `near-intents-exact`. Off by default. |
| `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY` | **Reused** from the existing NEAR relayer — no new key. |
| `NEAR_RPC_URL` | Optional; defaults to keyless FastNEAR. |
| `NEAR_INTENTS_CASE_B=1` | Enable any‑token‑in (Solver Relay). |
| `SOLVER_RELAY_API_KEY` | Partner `X-API-Key` for the Solver Relay (Case B). |
| `SOLVADOR_NEAR_CONFIDENTIAL=1` | Enable the 1Click confidential path (Phase 5). |
| `ONECLICK_JWT` | Partner JWT for 1Click (removes the 0.2% fee; unlocks confidentiality). |

## Bring‑up

```bash
cd solvador
git checkout feat/near-intents-exact
npm install                 # links the file: deps + their transitive deps
npm run typecheck           # clean
npm test                    # existing 57 pass (flag-gated integration is inert)

# enable it
echo "NEAR_INTENTS_EXACT=1" >> .env
npm run dev
curl localhost:4022/supported | jq '.kinds[] | select(.scheme=="near-intents-exact")'
curl "localhost:4022/schemes/near-intents-exact/nonce?maxTimeoutSeconds=120"
```

Billing, quota, webhooks, and the payment‑identifier idempotency layer all work unchanged: a
settlement writes an ordinary `transactions` row with `scheme = "near-intents-exact"`.

## Rollback

Set `NEAR_INTENTS_EXACT` unset/`0` (instant, no redeploy needed for discovery — the scheme simply
isn't registered). To fully remove, revert the branch. Nothing in the existing `exact`,
EVM/SVM/XRPL, billing, or dashboard paths is modified.

## Pre‑prod checklist (no testnet)

- `simulate_intents` runs in `verify` — unbalanced intents fail gas‑free.
- Dust‑amount mainnet round‑trip: 402 → client signs → `/settle` → `verifyNearTxReceipt` green.
- Confirm `/supported` lists both `exact` and `near-intents-exact` on `near:mainnet`.
- Confirm the relayer has a NEAR gas buffer.
