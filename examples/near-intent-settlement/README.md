# near-intent-settlement

Example x402 resource server + browser paywall for the **`multichain-exact`**
scheme — send-to-pay over NEAR Intents' 1Click API, against the Solvador
facilitator. The NEAR Intents counterpart of x402's
`examples/typescript/servers/express`. Live on mainnet:

- **`GET /premium`** is 402-gated. API clients get a `PAYMENT-REQUIRED` header;
  browsers get a paywall styled after the Solvador dashboard.
- The payer connects an **EVM wallet** and makes **one plain ERC-20 transfer**
  (Base USDC) to a one-time 1Click deposit address. No pre-deposit, no NEAR
  account, no message signing.
- 1Click swaps/bridges and delivers the **exact price directly to the
  merchant** (`solvador.near` receives native NEAR USDC in its own wallet —
  EXACT_OUTPUT, no withdraw step).
- The facilitator verifies and settles by re-fetching 1Click's **signed
  execution status** — that signed status is the receipt, re-checkable any time
  with `@solvador/near-receipt`.

```
payer wallet (Base USDC)
   │  ① POST /api/quote {refundTo}  → EXACT_OUTPUT quote + one-time deposit address
   │  ② ERC-20 transfer of quote.amountIn → depositAddress          [~1 tx]
   ▼
1Click: detect → swap/bridge → deliver                              [~35 s]
   ▼
solvador.near receives EXACTLY the price (native NEAR USDC, direct)
   │  ③ x402: GET /premium with payload {depositAddress}
   ▼
facilitator re-checks 1Click status + terms → settle → signed-status receipt
```

Failed/late/short deposits are auto-refunded by 1Click to the payer's
`refundTo` address (minus the refund fee).

## Prerequisites

1. **Solvador facilitator** on the `feat/near-intents-exact` branch, with its
   `.env` containing `NEAR_INTENTS_MULTICHAIN=1`. No relayer key is needed for
   this scheme (1Click executes); `ONECLICK_JWT` is optional and removes
   1Click's 0.2% fee. Check:

   ```bash
   curl -s localhost:4022/supported | jq '.kinds[] | select(.scheme=="multichain-exact")'
   curl -s "localhost:4022/schemes/multichain-exact/quote?amount=10000&asset=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1&payTo=solvador.near&refundTo=0xYourAddress&originAsset=nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
   ```

2. **A Solvador API key** (dashboard → API keys) — `/settle` is metered; the
   server sends it as `x-api-key`.

3. This monorepo installed and the paywall built:

   ```bash
   npm install
   npm run build:web -w @solvador/near-intent-settlement
   ```

## Run

```bash
cp examples/near-intent-settlement/.env.example examples/near-intent-settlement/.env
# fill SOLVADOR_API_KEY (and adjust PAY_TO / PRICE if needed)

npm run demo         # from the monorepo root
# → http://localhost:4021/premium
```

`.env`:

| Var | Meaning | Default |
|---|---|---|
| `FACILITATOR_URL` | Solvador facilitator base URL | `http://localhost:4022` |
| `SOLVADOR_API_KEY` | facilitator API key (settle) | — |
| `PAY_TO` | merchant destination account | `solvador.near` |
| `PRICE` | price of `/premium` ($ ≙ USDC, 6 dp, EXACT_OUTPUT) | `$0.01` |
| `PORT` | this server | `4021` |

## Headless client

```bash
REFUND_TO=0xYourAddress npm run client -w @solvador/near-intent-settlement
```

Requests a quote, prints the deposit address + `amountIn`, waits for you to
fund it from any wallet, polls 1Click to `SUCCESS`, then unlocks the resource
by presenting `{ depositAddress }` as the x402 payment.

## How the pieces map to the packages

| Piece | Package |
|---|---|
| verify/settle (status re-fetch, terms match, signed-status receipt, idempotency) + open quote endpoint | `@solvador/near-intents-facilitator` (`MultichainExactScheme`), running inside Solvador |
| `scheme-server.ts` — merchant `SchemeNetworkServer` (parsePrice → native NEAR USDC, `extra.quotePath` discovery) | this example |
| `MultichainExactClientScheme` — presents the deposit as the x402 payload | `@solvador/x402-near-intents-client` |
| 1Click REST client (quote/status/submit) | `@solvador/near-intents-core` |
| receipt re-verification (`POST /api/verify-receipt`) | `@solvador/near-receipt` |

### Security model (why a deposit can't be faked)

The facilitator never trusts the payload: it re-fetches the execution status
**from 1Click itself** and requires the quote's own recorded terms to match the
advertised requirements — `recipient == payTo`, `destinationAsset == asset`,
`swapType == EXACT_OUTPUT`, `amount == price`. A deposit that paid anyone else,
any other asset, or any other amount is unusable as payment here. The deposit
address is the idempotency key: a replay returns the cached receipt, never a
second unlock… and the merchant was paid directly, so there is nothing to
double-spend.

### Costs & latency (measured live)

- $0.01 payment: payer sends ≈ $0.010116 (route cost ≈ 1.2%: 1Click fee when
  keyless + solver spread; an `ONECLICK_JWT` removes the 0.2% part)
- delivery estimate ≈ 35 s after the Base transfer confirms
- refund fee (only on REFUNDED): 0.0024 USDC

## Paywall dev loop

```bash
npm run dev -w @solvador/near-intent-settlement       # server, :4021
npm run dev:web -w @solvador/near-intent-settlement   # Vite HMR, :5173 (proxies /premium + /api)
npm run build:web -w @solvador/near-intent-settlement # production bundle the server serves
```

## Mainnet checklist (there is no testnet)

- Price is dust (`$0.01`) by default — every payment moves real funds.
- Quotes expire (default deadline 10 min): pay soon after quoting; a late
  deposit is refunded, not lost.
- The scheme's deposit ledger (idempotency) is in-memory by default — a
  facilitator restart forgets settled deposit addresses; back it with a
  persistent store before real production traffic.
