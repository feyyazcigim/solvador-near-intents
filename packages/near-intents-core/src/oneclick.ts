/**
 * 1Click REST client (Phase 5 / confidential path).
 *
 * The client itself is plain HTTP; the *flag-gating* (SOLVADOR_NEAR_CONFIDENTIAL)
 * lives in the facilitator. A partner JWT (`Authorization: Bearer`) both removes
 * the 0.2% fee and unlocks `confidentiality`. Shapes are verbatim from the
 * official `@defuse-protocol/one-click-sdk-typescript` models.
 */
import { ONECLICK_BASE_URL } from "./constants.js";
import type { MultiPayload } from "./payload.js";
import type { OneClickToken } from "./tokens.js";

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type Confidentiality = "public" | "basic" | "advanced";

export type QuoteRequest = {
  dry: boolean;
  depositMode?: "SIMPLE" | "MEMO";
  swapType: SwapType;
  /** basis points; 100 = 1% */
  slippageTolerance: number;
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  /** integer string, base units; interpreted per swapType */
  amount: string;
  refundTo: string;
  refundType: DepositType;
  recipient: string;
  recipientType: RecipientType;
  /** ISO timestamp; when user refund begins */
  deadline: string;
  confidentiality?: Confidentiality;
  referral?: string;
  appFees?: Array<{ recipient: string; fee: number }>;
  rebates?: Array<{ recipient: string; share: number }>;
  quoteWaitingTimeMs?: number;
  [key: string]: unknown;
};

export type Quote = {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
  [key: string]: unknown;
};

export type QuoteResponse = {
  correlationId: string;
  timestamp: string;
  /** 1Click service signature over the quote+deposit address (dispute proof). */
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
};

export type OneClickStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export type ExecutionStatusResponse = {
  correlationId: string;
  quoteResponse: QuoteResponse;
  status: OneClickStatus;
  updatedAt: string;
  swapDetails: unknown;
};

export type AuthenticateResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
};

export type OneClickOptions = {
  baseUrl?: string;
  /** Partner JWT — sent as `Authorization: Bearer`. */
  jwt?: string;
  /** Partner API key — sent as `X-API-Key` (partner intent endpoints). */
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "OneClickError";
  }
}

export class OneClickClient {
  private readonly baseUrl: string;
  private readonly jwt?: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OneClickOptions = {}) {
    this.baseUrl = options.baseUrl ?? ONECLICK_BASE_URL;
    this.jwt = options.jwt;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** `GET /v0/tokens`. */
  getTokens(): Promise<OneClickToken[]> {
    return this.request<OneClickToken[]>("GET", "/v0/tokens");
  }

  /** `POST /v0/quote`. Set `dry:true` to price without allocating a deposit. */
  getQuote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.request<QuoteResponse>("POST", "/v0/quote", req);
  }

  /** `GET /v0/status?depositAddress=...`. */
  getStatus(depositAddress: string, depositMemo?: string): Promise<ExecutionStatusResponse> {
    const q = new URLSearchParams({ depositAddress });
    if (depositMemo) q.set("depositMemo", depositMemo);
    return this.request<ExecutionStatusResponse>("GET", `/v0/status?${q.toString()}`);
  }

  /** `POST /v0/deposit/submit`. */
  submitDepositTx(req: {
    txHash: string;
    depositAddress: string;
    nearSenderAccount?: string;
    memo?: string;
  }): Promise<ExecutionStatusResponse> {
    return this.request<ExecutionStatusResponse>("POST", "/v0/deposit/submit", req);
  }

  /** `POST /v0/auth/authenticate` — wallet-signature → session JWT. */
  authenticate(signedData: MultiPayload): Promise<AuthenticateResponse> {
    return this.request<AuthenticateResponse>("POST", "/v0/auth/authenticate", { signedData });
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.jwt) headers.authorization = `Bearer ${this.jwt}`;
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      throw new OneClickError(`1Click ${method} ${path} → HTTP ${res.status}`, res.status, parsed ?? text);
    }
    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
