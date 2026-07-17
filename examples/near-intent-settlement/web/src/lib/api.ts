/** Typed client for the example server's helper endpoints. */

export type PaywallConfig = {
  scheme: string;
  network: string;
  payTo: string;
  price: { amount: string; asset: string; decimals: number; display: string };
  origin: { asset: string; chain: string; baseUsdcAddress: string; decimals: number };
};

export type IssuedQuote = {
  depositAddress: string;
  depositMemo?: string;
  originAsset: string;
  destinationAsset: string;
  recipient: string;
  amountOut: string;
  amountIn: string;
  amountInFormatted: string;
  deadline?: string;
  timeEstimate: number;
  signature: string;
};

export type OneClickStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export type ExecutionStatus = {
  status: OneClickStatus;
  updatedAt?: string;
  [key: string]: unknown;
};

export type ReceiptVerification = {
  valid: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.url} → ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export const getConfig = () => fetch("/api/config").then((r) => json<PaywallConfig>(r));

export const requestQuote = (refundTo: string) =>
  fetch("/api/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refundTo }),
  }).then((r) => json<IssuedQuote>(r));

export const getStatus = (depositAddress: string) =>
  fetch(`/api/status?depositAddress=${encodeURIComponent(depositAddress)}`).then((r) =>
    json<ExecutionStatus>(r),
  );

export type FundResult = { txHash: string; chainId: number; tokenAddress: string };

/** Gas-sponsored funding: the facilitator broadcasts the signed authorization. */
export const fundDeposit = (depositAddress: string, authorization: Record<string, string>) =>
  fetch("/api/fund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ depositAddress, authorization }),
  }).then((r) => json<FundResult>(r));

export const submitDeposit = (txHash: string, depositAddress: string) =>
  fetch("/api/deposit-submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txHash, depositAddress }),
  }).then((r) => json<ExecutionStatus>(r));

export const verifyReceipt = (receipt: unknown) =>
  fetch("/api/verify-receipt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ receipt }),
  }).then((r) => json<ReceiptVerification>(r));
