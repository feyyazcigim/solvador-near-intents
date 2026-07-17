/**
 * Headless x402 client for the example server — the counterpart of x402's
 * `examples/typescript/clients/fetch`, paying via `multichain-exact`
 * (1Click send-to-pay).
 *
 *   REFUND_TO=0xYourAddress npm run client
 *
 * There is nothing to sign: the script requests an exact-output quote for the
 * paid route, prints the one-time deposit address + amount, waits for YOU to
 * fund it (any wallet, plain transfer), polls 1Click to SUCCESS, then unlocks
 * the resource by presenting the deposit as the x402 payment.
 */
import { config } from "dotenv";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { MultichainExactClientScheme } from "@solvador/x402-near-intents-client";

config({ path: new URL(".env", import.meta.url).pathname, quiet: true });

const baseUrl = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021";
const path = process.env.ENDPOINT_PATH ?? "/premium";
const refundTo = process.env.REFUND_TO;

async function main(): Promise<void> {
  if (!refundTo) {
    console.error("Set REFUND_TO=<your origin-chain address> (refund destination + quote identity).");
    process.exit(1);
  }

  const quoteRes = await fetch(`${baseUrl}/api/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refundTo }),
  });
  if (!quoteRes.ok) throw new Error(`quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = (await quoteRes.json()) as {
    depositAddress: string;
    amountIn: string;
    amountInFormatted: string;
    originAsset: string;
    recipient: string;
    timeEstimate: number;
    deadline?: string;
  };

  console.log("── fund this to pay ─────────────────────────────────────────");
  console.log(`  send      ${quote.amountInFormatted} USDC (Base)  [${quote.amountIn} atomic]`);
  console.log(`  to        ${quote.depositAddress}`);
  console.log(`  delivers  → ${quote.recipient} (exact output)`);
  console.log(`  eta       ~${quote.timeEstimate}s after deposit; quote deadline ${quote.deadline ?? "-"}`);
  console.log("─────────────────────────────────────────────────────────────");
  console.log("waiting for 1Click status → SUCCESS …");

  for (;;) {
    const s = (await fetch(
      `${baseUrl}/api/status?depositAddress=${encodeURIComponent(quote.depositAddress)}`,
    ).then((r) => r.json())) as { status?: string };
    process.stdout.write(`  status: ${s.status ?? "?"}        \r`);
    if (s.status === "SUCCESS") break;
    if (s.status === "REFUNDED" || s.status === "FAILED") {
      throw new Error(`terminal status ${s.status}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log("\ndeposit delivered — presenting it as the x402 payment…");

  const client = new x402Client();
  client.register("near:mainnet", new MultichainExactClientScheme({ depositAddress: quote.depositAddress }));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);
  const res = await fetchWithPay(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
  console.log(`HTTP ${res.status}`);
  const header = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  if (header) console.dir(decodePaymentResponseHeader(header), { depth: 4 });
  console.dir(await res.json().catch(() => undefined), { depth: null });
  if (!res.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
