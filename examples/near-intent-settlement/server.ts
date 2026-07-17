/**
 * near-intent-settlement — example x402 resource server + paywall, modeled on
 * x402's `examples/typescript/servers/express`, for the `multichain-exact`
 * scheme (1Click send-to-pay) against the Solvador facilitator
 * (feat/near-intents-exact branch, NEAR_INTENTS_MULTICHAIN=1). Live mainnet:
 *
 *   GET /premium          402-gated content; browsers get the paywall. The payer
 *                         funds a one-time 1Click deposit address (Base USDC by
 *                         default) and 1Click delivers native NEAR USDC DIRECTLY
 *                         to PAY_TO (solvador.near) — no payer intents balance,
 *                         no merchant withdraw step.
 *   GET  /api/config      constants for the paywall UI
 *   POST /api/quote       EXACT_OUTPUT quote (proxied to the facilitator's open
 *                         quote endpoint with the payer's refund address)
 *   GET  /api/status      1Click execution status for a deposit address
 *   POST /api/deposit-submit  forward the origin tx hash (faster detection)
 *   POST /api/verify-receipt  merchant-side @solvador/near-receipt check
 *
 *   npm run demo          (from the monorepo root; see README)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type PaywallProvider } from "@x402/core/server";
import { fromAtomicUnits, toAtomicUnits, OneClickClient } from "@solvador/near-intents-core";
import type { OneClickSignedStatusReceipt } from "@solvador/near-intents-core";
import { verifyOneClickReceipt } from "@solvador/near-receipt";
import {
  DEFAULT_ORIGIN_ASSET,
  DESTINATION_ASSET,
  MultichainExactServerScheme,
  NETWORK,
  SCHEME,
  USDC_DECIMALS,
} from "./scheme-server.js";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, ".env"), quiet: true });

// ── configuration ─────────────────────────────────────────────────────────────
const port = Number(process.env.PORT ?? 4021);
const facilitatorUrl = (process.env.FACILITATOR_URL ?? "http://localhost:4022").replace(/\/$/, "");
const apiKey = process.env.SOLVADOR_API_KEY;
const payTo = process.env.PAY_TO ?? "solvador.near";
const price = process.env.PRICE ?? "$0.01";

if (!apiKey) {
  console.warn(
    "⚠️  SOLVADOR_API_KEY is not set — /verify and the paywall will work, but the " +
      "facilitator will reject /settle with 401. Create a key in the Solvador dashboard.",
  );
}

const priceAtomic = toAtomicUnits(price.replace(/^\$/, ""), USDC_DECIMALS).toString();
const quotePath = `/schemes/${SCHEME}/quote`;
const fundPath = `/schemes/${SCHEME}/fund`;

/** Circle USDC (ERC-20) on Base — what the paywall's wallet actually sends. */
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Keyless 1Click client for status reads (status is public per deposit address).
const oneClick = new OneClickClient();

// ── x402 wiring (mirrors the x402 express example) ────────────────────────────
const facilitatorClient = new HTTPFacilitatorClient({
  url: facilitatorUrl,
  ...(apiKey
    ? {
        createAuthHeaders: async () => ({
          verify: { "x-api-key": apiKey },
          settle: { "x-api-key": apiKey },
          supported: {},
        }),
      }
    : {}),
});

const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new MultichainExactServerScheme(),
);

// ── paywall provider: the built web app with the 402 payload injected ────────
const webDist = join(here, "web", "dist");
let paywallTemplate: string | undefined;

function loadPaywallTemplate(): string {
  if (paywallTemplate) return paywallTemplate;
  const indexHtml = join(webDist, "index.html");
  if (!existsSync(indexHtml)) {
    return (
      "<!doctype html><meta charset=utf-8><title>Solvador paywall</title>" +
      "<body style='font-family:monospace;padding:4rem;background:#F4F1EB;color:#1A1611'>" +
      "<h1>Paywall not built</h1><p>Run <code>npm run build:web -w @solvador/near-intent-settlement</code> " +
      "then reload. (API 402 flow works regardless — this only affects browsers.)</p>"
    );
  }
  paywallTemplate = readFileSync(indexHtml, "utf8");
  return paywallTemplate;
}

const paywall: PaywallProvider = {
  generateHtml(paymentRequired) {
    const json = JSON.stringify(paymentRequired).replace(/</g, "\\u003c");
    return loadPaywallTemplate().replace(
      "</head>",
      `<script>window.__X402_PAYMENT_REQUIRED__ = ${json};</script></head>`,
    );
  },
};

// ── app ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/api/config", (_req, res) => {
  res.json({
    scheme: SCHEME,
    network: NETWORK,
    payTo,
    price: {
      amount: priceAtomic,
      asset: DESTINATION_ASSET,
      decimals: USDC_DECIMALS,
      display: `$${fromAtomicUnits(BigInt(priceAtomic), USDC_DECIMALS)}`,
    },
    origin: {
      asset: DEFAULT_ORIGIN_ASSET,
      chain: "base",
      baseUsdcAddress: BASE_USDC_ADDRESS,
      decimals: USDC_DECIMALS,
    },
  });
});

/**
 * EXACT_OUTPUT quote for THIS resource's terms, with refunds to the payer.
 * Proxied to the facilitator's open quote endpoint so the paywall needs no
 * facilitator URL of its own.
 */
app.post("/api/quote", async (req, res) => {
  const refundTo = typeof req.body?.refundTo === "string" ? req.body.refundTo.trim() : "";
  if (!refundTo) return void res.status(400).json({ error: "body.refundTo required" });
  const originAsset =
    typeof req.body?.originAsset === "string" && req.body.originAsset.trim() !== ""
      ? req.body.originAsset.trim()
      : DEFAULT_ORIGIN_ASSET;
  const q = new URLSearchParams({
    amount: priceAtomic,
    asset: DESTINATION_ASSET,
    payTo,
    refundTo,
    originAsset,
  });
  try {
    const upstream = await fetch(`${facilitatorUrl}${quotePath}?${q.toString()}`);
    const body = await upstream.json();
    res.status(upstream.status).json(body);
  } catch (e) {
    res.status(502).json({ error: msg(e) });
  }
});

/**
 * Gas-sponsored funding: forward the payer's signed EIP-3009 authorization to
 * the facilitator, which validates it against the deposit's own 1Click quote
 * and broadcasts it on Base (relayer pays the gas). The payer never sends a
 * transaction — one signature is the whole payment.
 */
app.post("/api/fund", async (req, res) => {
  try {
    const upstream = await fetch(`${facilitatorUrl}${fundPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    });
    res.status(upstream.status).json(await upstream.json());
  } catch (e) {
    res.status(502).json({ error: msg(e) });
  }
});

app.get("/api/status", async (req, res) => {
  const depositAddress = typeof req.query.depositAddress === "string" ? req.query.depositAddress : "";
  if (!depositAddress) return void res.status(400).json({ error: "?depositAddress required" });
  try {
    const status = await oneClick.getStatus(
      depositAddress,
      typeof req.query.depositMemo === "string" ? req.query.depositMemo : undefined,
    );
    res.json(status);
  } catch (e) {
    res.status(502).json({ error: msg(e) });
  }
});

app.post("/api/deposit-submit", async (req, res) => {
  const { txHash, depositAddress } = (req.body ?? {}) as { txHash?: string; depositAddress?: string };
  if (!txHash || !depositAddress) {
    return void res.status(400).json({ error: "body.txHash and body.depositAddress required" });
  }
  try {
    res.json(await oneClick.submitDepositTx({ txHash, depositAddress }));
  } catch (e) {
    res.status(502).json({ error: msg(e) });
  }
});

// Merchant-side proof: check the 1Click signed status is terminal-success AND
// that its own recorded terms pay THIS server (recipient/asset/amount).
app.post("/api/verify-receipt", async (req, res) => {
  const receipt = req.body?.receipt as OneClickSignedStatusReceipt | undefined;
  if (!receipt || receipt.kind !== "oneclick-signed-status") {
    return void res.status(400).json({ error: "body.receipt must be an oneclick-signed-status receipt" });
  }
  try {
    const result = await verifyOneClickReceipt(receipt);
    const q = receipt.statusResponse?.quoteResponse?.quoteRequest;
    const termsOk =
      q?.recipient === payTo && q?.destinationAsset === DESTINATION_ASSET && q?.amount === priceAtomic;
    res.json(
      result.valid && !termsOk
        ? { valid: false, reason: "signed status does not pay this merchant's terms" }
        : result,
    );
  } catch (e) {
    res.status(502).json({ error: msg(e) });
  }
});

// ── the paid route ────────────────────────────────────────────────────────────
app.use(
  paymentMiddleware(
    {
      "GET /premium": {
        accepts: [{ scheme: SCHEME, network: NETWORK, payTo, price }],
        description: "Solvador premium demo content, paid from any chain via NEAR Intents (1Click)",
        mimeType: "application/json",
        // Surface WHY a settlement failed (DEPOSIT_PENDING / DEPOSIT_REFUNDED…)
        // instead of a bare 402 — the paywall shows this verbatim.
        settlementFailedResponseBody: (_ctx, settleResult) => {
          console.error("[near-intent-settlement] settle failed:", JSON.stringify(settleResult));
          return { contentType: "application/json", body: { error: "settlement_failed", ...settleResult } };
        },
      },
    },
    resourceServer,
    { appName: "Solvador Paywall" },
    paywall,
  ),
);

app.get("/premium", (_req, res) => {
  res.json({
    report: {
      title: "Solvador premium signal",
      pair: "NEAR/USDC",
      verdict: "☀️ constructive",
      note:
        "This JSON is the paid resource. It was unlocked by funding a one-time " +
        "1Click deposit address — the exact amount was delivered straight to the " +
        "merchant's wallet, settled by the Solvador facilitator.",
      generatedAt: new Date().toISOString(),
    },
    settledVia: { scheme: SCHEME, network: NETWORK, payTo },
  });
});

// ── static paywall assets + landing ───────────────────────────────────────────
app.use(express.static(webDist, { index: false }));
app.get("/", (_req, res) => res.redirect("/premium"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(port, () => {
  console.log(`near-intent-settlement listening at http://localhost:${port}`);
  console.log(`  paid route   GET /premium  (${price} → ${payTo} on ${NETWORK} via ${SCHEME})`);
  console.log(`  facilitator  ${facilitatorUrl}`);
});

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
