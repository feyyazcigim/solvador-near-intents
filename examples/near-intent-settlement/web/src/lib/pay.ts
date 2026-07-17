/**
 * The x402 leg of multichain-exact: once the deposit reached SUCCESS, present
 * `{ depositAddress }` as the payment. The facilitator re-fetches the status
 * from 1Click itself, so there is nothing to sign here.
 */
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { MultichainExactClientScheme } from "@solvador/x402-near-intents-client";

export type SettleReceipt = {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  extra?: { receipt?: Record<string, unknown>; [key: string]: unknown };
};

export type UnlockResult = {
  content: unknown;
  settle?: SettleReceipt;
};

export async function unlockPremium(depositAddress: string, originTxHash?: string): Promise<UnlockResult> {
  const client = new x402Client();
  client.register(
    "near:mainnet",
    new MultichainExactClientScheme({ depositAddress, ...(originTxHash ? { originTxHash } : {}) }),
  );
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const attempt = () => fetchWithPay("/premium", { headers: { accept: "application/json" } });

  let response: Response;
  try {
    response = await attempt();
  } catch {
    response = await attempt(); // one retry (e.g. DEPOSIT_PENDING race)
  }
  if (response.status === 402) response = await attempt();

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Payment failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  }

  const header =
    response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  let settle: SettleReceipt | undefined;
  if (header) {
    try {
      settle = decodePaymentResponseHeader(header) as SettleReceipt;
    } catch {
      settle = undefined;
    }
  }
  return { content: await response.json(), settle };
}
