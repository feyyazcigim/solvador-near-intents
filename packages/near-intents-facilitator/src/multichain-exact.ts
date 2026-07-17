/**
 * `multichain-exact` — send-to-pay x402 scheme over the 1Click API (public
 * mode; no confidentiality, no JWT required — a JWT just removes the 0.2% fee).
 *
 * Flow (async settlement):
 *   1. Merchant advertises the scheme; `extra.quotePath` points at this
 *      facilitator's open quote endpoint.
 *   2. The payer requests a quote (EXACT_OUTPUT of `amount`:`asset` delivered
 *      DIRECTLY to `payTo`, refunds to the payer's own address) and receives a
 *      one-time `depositAddress` on their chosen origin chain.
 *   3. The payer sends `amountIn` to the deposit address — a plain transfer,
 *      no wallet standard, no NEAR account.
 *   4. 1Click swaps/bridges and delivers to `payTo`; the payer (typically after
 *      polling status to SUCCESS) presents `{ depositAddress }` as the payment.
 *   5. verify()/settle() re-fetch the status FROM 1CLICK (never trusting the
 *      payload) and match the quote's own terms — recipient, destinationAsset,
 *      EXACT_OUTPUT amount — against the advertised requirements. The receipt
 *      is 1Click's signed status (`oneclick-signed-status`).
 *
 * Security model: the terms come out of 1Click's status response (server-to-
 * server), so a payer can only ever "pay" with a deposit that truly delivered
 * the required amount to the required recipient. The deposit address itself is
 * the idempotency key — an in-store replay returns the cached receipt.
 */
import {
  KNOWN_EIP3009_DOMAINS,
  MULTICHAIN_EXACT_SCHEME,
  NEAR_MAINNET_CAIP2,
  oneClickSignedStatusReceipt,
  OneClickClient,
  OneClickError,
  parseOmftErc20,
  recoverTransferAuthorizationSigner,
  type ExecutionStatusResponse,
  type OneClickSignedStatusReceipt,
  type OneClickStatus,
  type QuoteRequest,
  type TransferAuthorization,
} from "@solvador/near-intents-core";
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { NearIntentsError, NearIntentsErrorCode as EC, isRetriable } from "./errors.js";

/** The scheme-specific `PaymentPayload.payload` a payer submits. */
export type OneClickPaymentPayload = {
  /** The one-time 1Click deposit address the payer funded. */
  depositAddress: string;
  /** MEMO deposit mode only. */
  depositMemo?: string;
  /** Origin-chain tx hash — forwarded to /v0/deposit/submit to speed detection. */
  originTxHash?: string;
};

/** What the quote endpoint returns to payers (superset lives in 1Click's reply). */
export type IssuedQuote = {
  depositAddress: string;
  depositMemo?: string;
  originAsset: string;
  destinationAsset: string;
  recipient: string;
  /** EXACT_OUTPUT — what the merchant receives. */
  amountOut: string;
  /** What the payer must send to the deposit address. */
  amountIn: string;
  amountInFormatted: string;
  /** ISO time when the quote stops being fundable / refunds begin. */
  deadline?: string;
  /** 1Click's execution estimate, seconds. */
  timeEstimate: number;
  /** 1Click's signature over the quote (dispute proof). */
  signature: string;
};

const PENDING: ReadonlySet<OneClickStatus> = new Set<OneClickStatus>([
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
]);

type DepositRecord = {
  status: "settling" | "settled" | "failed";
  transaction?: string;
  receipt?: OneClickSignedStatusReceipt;
};

/**
 * Broadcasts a signed EIP-3009 `transferWithAuthorization` on the origin chain
 * and returns the tx hash. Injected by the host (Solvador wires its existing
 * per-network viem clients) so this package stays EVM-library-free.
 */
export type FundBroadcaster = (args: {
  chainId: number;
  tokenAddress: string;
  authorization: TransferAuthorization;
}) => Promise<string>;

export type MultichainExactSchemeConfig = {
  /** 1Click client (JWT optional — removes the 0.2% fee when present). */
  oneClick: OneClickClient;
  /**
   * Gas sponsorship: when set, the fund endpoint accepts signed EIP-3009
   * authorizations and broadcasts them at the facilitator's expense — the
   * payer needs zero origin-chain gas.
   */
  fundBroadcaster?: FundBroadcaster;
  /** Network id (default `near:mainnet`). */
  network?: string;
  /** Quote deadline seconds when the endpoint request omits one (default 600). */
  defaultQuoteDeadlineSeconds?: number;
  /** Cap on requested quote deadlines (default 3600). */
  maxQuoteDeadlineSeconds?: number;
  /** Slippage tolerance in bps for issued quotes (default 100 = 1%). */
  slippageToleranceBps?: number;
  /** settle(): how long to poll for a terminal status, ms (default 90s). */
  pollTimeoutMs?: number;
  /** settle(): poll interval, ms (default 3s). */
  pollIntervalMs?: number;
  /** Injectable clock/sleep (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class MultichainExactScheme implements SchemeNetworkFacilitator {
  readonly scheme = MULTICHAIN_EXACT_SCHEME;
  readonly caipFamily = "near:*";

  private readonly oneClick: OneClickClient;
  private readonly network: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly config: MultichainExactSchemeConfig;
  /** depositAddress → settle lifecycle (idempotency). In-memory, like the nonce store default. */
  private readonly deposits = new Map<string, DepositRecord>();

  constructor(config: MultichainExactSchemeConfig) {
    this.config = config;
    this.oneClick = config.oneClick;
    this.network = config.network ?? NEAR_MAINNET_CAIP2;
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Advertised in /supported `kinds[].extra` so resource servers can discover the endpoints. */
  getExtra(_network: string): Record<string, unknown> | undefined {
    return {
      quotePath: this.quotePath,
      ...(this.config.fundBroadcaster ? { fundPath: this.fundPath, sponsored: true } : {}),
    };
  }

  /** No facilitator-held chain keys on this scheme (1Click executes). */
  getSigners(_network: string): string[] {
    return [];
  }

  get quotePath(): string {
    return `/schemes/${this.scheme}/quote`;
  }

  get fundPath(): string {
    return `/schemes/${this.scheme}/fund`;
  }

  /**
   * Gas-sponsored funding: validate a signed EIP-3009 authorization against the
   * deposit's own 1Click quote, broadcast it on the origin chain (facilitator
   * pays gas), and nudge 1Click detection with the tx hash.
   */
  async fundDeposit(params: {
    depositAddress: string;
    authorization: TransferAuthorization;
  }): Promise<{ txHash: string; chainId: number; tokenAddress: string }> {
    const broadcast = this.config.fundBroadcaster;
    if (!broadcast) throw new NearIntentsError(EC.INTERNAL_ERROR, "fund sponsorship not enabled");

    // The deposit must be a real, still-fundable 1Click quote.
    const status = await this.fetchStatus({ depositAddress: params.depositAddress });
    if (!PENDING.has(status.status)) {
      throw new NearIntentsError(EC.TERMS_MISMATCH, `deposit not fundable (status ${status.status})`);
    }
    const q = status.quoteResponse?.quoteRequest;
    const quote = status.quoteResponse?.quote;
    if (!q || !quote) throw new NearIntentsError(EC.UPSTREAM_ERROR, "status carries no quote");

    // Only ERC-20 omft origins are sponsorable (native coins can't do 3009).
    const token = parseOmftErc20(String(q.originAsset));
    if (!token) {
      throw new NearIntentsError(EC.TERMS_MISMATCH, `origin ${q.originAsset} is not a sponsorable ERC-20`);
    }

    const auth = params.authorization;
    if (auth.to.toLowerCase() !== params.depositAddress.toLowerCase()) {
      throw new NearIntentsError(EC.WRONG_RECIPIENT, "authorization.to ≠ depositAddress");
    }
    if (auth.value !== quote.amountIn) {
      throw new NearIntentsError(EC.WRONG_AMOUNT, `authorization.value ${auth.value} ≠ amountIn ${quote.amountIn}`);
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (BigInt(auth.validAfter) > BigInt(nowSec)) {
      throw new NearIntentsError(EC.TERMS_MISMATCH, "authorization not valid yet");
    }
    if (BigInt(auth.validBefore) < BigInt(nowSec + 60)) {
      throw new NearIntentsError(EC.DEADLINE_EXCEEDED, "authorization expires too soon");
    }

    // Pre-verify the signature for known token domains — saves relayer gas on
    // garbage. Unknown domains skip this; the tx itself reverts on bad sigs.
    const domain = KNOWN_EIP3009_DOMAINS[`${token.chainId}:${token.tokenAddress}`];
    if (domain) {
      let signer: string;
      try {
        signer = recoverTransferAuthorizationSigner(domain, auth);
      } catch (e) {
        throw new NearIntentsError(EC.INVALID_SIGNATURE, msg(e));
      }
      if (signer !== auth.from.toLowerCase()) {
        throw new NearIntentsError(EC.INVALID_SIGNATURE, `recovered ${signer} ≠ from ${auth.from}`);
      }
    }

    const txHash = await broadcast({
      chainId: token.chainId,
      tokenAddress: token.tokenAddress,
      authorization: auth,
    });
    await this.oneClick
      .submitDepositTx({ txHash, depositAddress: params.depositAddress })
      .catch(() => undefined);
    return { txHash, chainId: token.chainId, tokenAddress: token.tokenAddress };
  }

  /**
   * Request a live (non-dry) EXACT_OUTPUT quote delivering `amount`:`asset`
   * directly to `payTo`, funded from `originAsset` on its origin chain, with
   * refunds going to the payer's `refundTo`.
   */
  async issueQuote(params: {
    amount: string;
    asset: string;
    payTo: string;
    refundTo: string;
    originAsset: string;
    deadlineSeconds?: number;
  }): Promise<IssuedQuote> {
    const dflt = this.config.defaultQuoteDeadlineSeconds ?? 600;
    const cap = this.config.maxQuoteDeadlineSeconds ?? 3600;
    const seconds = Math.min(Math.max(params.deadlineSeconds ?? dflt, 60), cap);
    const request: QuoteRequest = {
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: this.config.slippageToleranceBps ?? 100,
      originAsset: params.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: params.asset,
      amount: params.amount,
      refundTo: params.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: params.payTo,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(this.now() + seconds * 1000).toISOString(),
    };
    const res = await this.oneClick.getQuote(request);
    if (!res.quote.depositAddress) {
      throw new NearIntentsError(EC.NO_QUOTE, "1Click returned no deposit address");
    }
    return {
      depositAddress: res.quote.depositAddress,
      ...(res.quote.depositMemo ? { depositMemo: res.quote.depositMemo } : {}),
      originAsset: params.originAsset,
      destinationAsset: params.asset,
      recipient: params.payTo,
      amountOut: res.quote.amountOut,
      amountIn: res.quote.amountIn,
      amountInFormatted: res.quote.amountInFormatted,
      ...(res.quote.deadline ? { deadline: res.quote.deadline } : {}),
      timeEstimate: res.quote.timeEstimate,
      signature: res.signature,
    };
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    try {
      const { status } = await this.checkDeposit(payload, requirements);
      return {
        isValid: true,
        payer: String(status.quoteResponse.quoteRequest.refundTo ?? ""),
        extra: { oneClickStatus: status.status },
      };
    } catch (e) {
      const { code, message } = classify(e);
      return {
        isValid: false,
        invalidReason: code,
        invalidMessage: message,
        extra: { retriable: isRetriable(code) },
      };
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    let body: OneClickPaymentPayload;
    try {
      body = parsePayload(payload);
    } catch (e) {
      return this.settleFailure(e);
    }

    // Idempotency / concurrent-dup gate on the deposit address.
    const existing = this.deposits.get(body.depositAddress);
    if (existing?.status === "settled" && existing.receipt) {
      return this.settled(existing.transaction ?? body.depositAddress, existing.receipt, requirements);
    }
    if (existing?.status === "settling") {
      return this.settleFailure(new NearIntentsError(EC.INTERNAL_ERROR, "settlement already in progress"));
    }
    this.deposits.set(body.depositAddress, { status: "settling" });

    try {
      // Poll to a terminal status (the payer usually arrives after SUCCESS, so
      // this returns immediately), re-validating the terms against 1Click's
      // own signed record.
      const status = await this.pollToTerminal(body, requirements);
      const transaction = extractTxHash(status) ?? body.depositAddress;
      const receipt = oneClickSignedStatusReceipt({
        depositAddress: body.depositAddress,
        statusResponse: status,
        scheme: this.scheme,
        network: this.network,
        ...(requirements.extra?.paymentId ? { paymentId: String(requirements.extra.paymentId) } : {}),
      });
      this.deposits.set(body.depositAddress, { status: "settled", transaction, receipt });
      return this.settled(transaction, receipt, requirements);
    } catch (e) {
      this.deposits.set(body.depositAddress, { status: "failed" });
      return this.settleFailure(e);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Fetch status from 1Click and require terms-match; throws taxonomy errors. */
  private async checkDeposit(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ body: OneClickPaymentPayload; status: ExecutionStatusResponse }> {
    const body = parsePayload(payload);
    const status = await this.fetchStatus(body);
    this.assertTerms(status, requirements);
    this.assertTerminalSuccess(status);
    return { body, status };
  }

  private async fetchStatus(body: OneClickPaymentPayload): Promise<ExecutionStatusResponse> {
    try {
      return await this.oneClick.getStatus(body.depositAddress, body.depositMemo);
    } catch (e) {
      if (e instanceof OneClickError && e.status === 404) {
        throw new NearIntentsError(EC.UNKNOWN_DEPOSIT, `1Click doesn't know ${body.depositAddress}`);
      }
      throw new NearIntentsError(EC.UPSTREAM_ERROR, msg(e));
    }
  }

  /**
   * The quote's own terms (as recorded and signed by 1Click) must match the
   * advertised requirements — recipient, destination asset, and EXACT_OUTPUT
   * amount. This is what makes a foreign deposit address unusable as payment.
   */
  private assertTerms(status: ExecutionStatusResponse, requirements: PaymentRequirements): void {
    const q = status.quoteResponse?.quoteRequest;
    if (!q) throw new NearIntentsError(EC.UPSTREAM_ERROR, "status carries no quoteRequest");
    if (q.recipient !== requirements.payTo) {
      throw new NearIntentsError(EC.WRONG_RECIPIENT, `${q.recipient} ≠ ${requirements.payTo}`);
    }
    if (q.destinationAsset !== requirements.asset) {
      throw new NearIntentsError(EC.WRONG_ASSET, `${q.destinationAsset} ≠ ${requirements.asset}`);
    }
    if (q.swapType !== "EXACT_OUTPUT" || q.amount !== requirements.amount) {
      throw new NearIntentsError(EC.WRONG_AMOUNT, `${q.swapType} ${q.amount} ≠ EXACT_OUTPUT ${requirements.amount}`);
    }
    if (q.recipientType !== "DESTINATION_CHAIN" && q.recipientType !== "INTENTS") {
      throw new NearIntentsError(EC.TERMS_MISMATCH, `recipientType ${q.recipientType}`);
    }
  }

  private assertTerminalSuccess(status: ExecutionStatusResponse): void {
    if (status.status === "SUCCESS") return;
    if (PENDING.has(status.status)) {
      throw new NearIntentsError(EC.DEPOSIT_PENDING, `1Click status ${status.status}`);
    }
    if (status.status === "REFUNDED") {
      throw new NearIntentsError(EC.DEPOSIT_REFUNDED, "deposit was refunded");
    }
    throw new NearIntentsError(EC.DEPOSIT_FAILED, `1Click status ${status.status}`);
  }

  private async pollToTerminal(
    body: OneClickPaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<ExecutionStatusResponse> {
    // Speed up detection when the payer told us their origin tx.
    if (body.originTxHash) {
      await this.oneClick
        .submitDepositTx({ txHash: body.originTxHash, depositAddress: body.depositAddress })
        .catch(() => undefined);
    }
    const timeout = this.now() + (this.config.pollTimeoutMs ?? 90_000);
    const interval = this.config.pollIntervalMs ?? 3_000;
    for (;;) {
      const status = await this.fetchStatus(body);
      this.assertTerms(status, requirements);
      if (!PENDING.has(status.status)) {
        this.assertTerminalSuccess(status); // throws on REFUNDED/FAILED
        return status;
      }
      if (this.now() >= timeout) {
        throw new NearIntentsError(EC.DEPOSIT_PENDING, `still ${status.status} after poll timeout`);
      }
      await this.sleep(interval);
    }
  }

  private settled(
    transaction: string,
    receipt: OneClickSignedStatusReceipt,
    requirements: PaymentRequirements,
  ): SettleResponse {
    return {
      success: true,
      payer: String(receipt.statusResponse.quoteResponse.quoteRequest.refundTo ?? ""),
      transaction,
      network: this.network as SettleResponse["network"],
      amount: requirements.amount,
      extra: { receipt },
    };
  }

  private settleFailure(e: unknown): SettleResponse {
    const { code, message } = classify(e);
    return {
      success: false,
      errorReason: code,
      errorMessage: message,
      transaction: "",
      network: this.network as SettleResponse["network"],
      extra: { retriable: isRetriable(code) },
    };
  }
}

// ── registration + quote endpoint (framework-free, mirrors the nonce handler) ──

/** Just the `register` surface of `@x402/core`'s `x402Facilitator`. */
interface RegisterableFacilitator {
  register(networks: string | string[], facilitator: unknown): unknown;
}

export interface QuoteHttpRequest {
  query: Record<string, unknown>;
}
export interface QuoteHttpResponse {
  status(code: number): QuoteHttpResponse;
  json(body: unknown): unknown;
}
export type QuoteRouteHandler = (req: QuoteHttpRequest, res: QuoteHttpResponse) => Promise<void>;

export type RegisterMultichainExactOptions = {
  /** 1Click auth (JWT removes the 0.2% fee). Omit for keyless public use. */
  jwt?: string;
  network?: string;
  /** Gas sponsorship: broadcast signed EIP-3009 authorizations (facilitator pays gas). */
  fundBroadcaster?: FundBroadcaster;
  /** Pre-built client / scheme overrides (tests). */
  oneClick?: OneClickClient;
  scheme?: Partial<MultichainExactSchemeConfig>;
};

export type RegisterMultichainExactResult = {
  scheme: MultichainExactScheme;
  quoteHandler: QuoteRouteHandler;
  quotePath: string;
  /** Present iff `fundBroadcaster` was configured. Mount as POST. */
  fundHandler?: FundRouteHandler;
  fundPath?: string;
};

/** Build + register the 1Click scheme; mount `quoteHandler` at `quotePath`. */
export function registerMultichainExact(
  facilitator: RegisterableFacilitator,
  opts: RegisterMultichainExactOptions = {},
): RegisterMultichainExactResult {
  const oneClick = opts.oneClick ?? new OneClickClient(opts.jwt ? { jwt: opts.jwt } : {});
  const scheme = new MultichainExactScheme({
    oneClick,
    ...(opts.network ? { network: opts.network } : {}),
    ...(opts.fundBroadcaster ? { fundBroadcaster: opts.fundBroadcaster } : {}),
    ...opts.scheme,
  });
  facilitator.register(opts.network ?? NEAR_MAINNET_CAIP2, scheme);
  return {
    scheme,
    quoteHandler: createQuoteRouteHandler(scheme),
    quotePath: scheme.quotePath,
    ...(opts.fundBroadcaster || opts.scheme?.fundBroadcaster
      ? { fundHandler: createFundRouteHandler(scheme), fundPath: scheme.fundPath }
      : {}),
  };
}

// ── fund endpoint (POST; body = { depositAddress, authorization }) ────────────

export interface FundHttpRequest {
  body?: unknown;
}
export type FundRouteHandler = (req: FundHttpRequest, res: QuoteHttpResponse) => Promise<void>;

/**
 * `POST .../fund` — gas-sponsored funding. Open like the quote endpoint, but
 * bounded: it only broadcasts authorizations that pay INTO a live 1Click
 * deposit address for its exact `amountIn`, and pre-verifies signatures for
 * known token domains. The facilitator's cost per request is one ERC-20
 * transfer's gas on the origin chain.
 */
export function createFundRouteHandler(scheme: MultichainExactScheme): FundRouteHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as {
      depositAddress?: unknown;
      authorization?: Partial<TransferAuthorization>;
    };
    const a = body.authorization;
    const ok =
      typeof body.depositAddress === "string" &&
      a &&
      [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.signature].every(
        (v) => typeof v === "string" && v !== "",
      );
    if (!ok) {
      res.status(400).json({ error: "required: depositAddress, authorization{from,to,value,validAfter,validBefore,nonce,signature}" });
      return;
    }
    try {
      res.json(
        await scheme.fundDeposit({
          depositAddress: body.depositAddress as string,
          authorization: a as TransferAuthorization,
        }),
      );
    } catch (e) {
      const status = e instanceof NearIntentsError ? 422 : 502;
      res.status(status).json({
        error: e instanceof Error ? e.message : String(e),
        ...(e instanceof NearIntentsError ? { code: e.code } : {}),
      });
    }
  };
}

/**
 * `GET .../quote?amount=&asset=&payTo=&refundTo=&originAsset=[&deadlineSeconds=]`
 *
 * Open, like the nonce endpoint: quotes are offers, not commitments to settle —
 * verify/settle only ever accept deposits whose 1Click-recorded terms match the
 * merchant's advertised requirements.
 */
export function createQuoteRouteHandler(scheme: MultichainExactScheme): QuoteRouteHandler {
  return async (req, res) => {
    const p = (k: string): string | undefined => {
      const v = req.query[k];
      const s = Array.isArray(v) ? v[0] : v;
      return typeof s === "string" && s.trim() !== "" ? s.trim() : undefined;
    };
    const amount = p("amount");
    const asset = p("asset");
    const payTo = p("payTo");
    const refundTo = p("refundTo");
    const originAsset = p("originAsset");
    if (!amount || !/^\d+$/.test(amount) || !asset || !payTo || !refundTo || !originAsset) {
      res.status(400).json({ error: "required: amount (digits), asset, payTo, refundTo, originAsset" });
      return;
    }
    const rawDeadline = Number.parseInt(p("deadlineSeconds") ?? "", 10);
    try {
      res.json(
        await scheme.issueQuote({
          amount,
          asset,
          payTo,
          refundTo,
          originAsset,
          ...(Number.isFinite(rawDeadline) && rawDeadline > 0 ? { deadlineSeconds: rawDeadline } : {}),
        }),
      );
    } catch (e) {
      res.status(502).json({ error: msg(e) });
    }
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function parsePayload(payload: PaymentPayload): OneClickPaymentPayload {
  const body = payload.payload as OneClickPaymentPayload | undefined;
  if (!body || typeof body !== "object" || typeof body.depositAddress !== "string" || !body.depositAddress) {
    throw new NearIntentsError(EC.MALFORMED_PAYLOAD, "missing payload.depositAddress");
  }
  return body;
}

/** Best-effort settlement tx hash out of 1Click's loosely-typed swapDetails. */
function extractTxHash(status: ExecutionStatusResponse): string | undefined {
  const d = status.swapDetails as
    | {
        destinationChainTxHashes?: Array<{ hash?: string }>;
        nearTxHashes?: string[];
      }
    | undefined;
  return d?.destinationChainTxHashes?.[0]?.hash ?? d?.nearTxHashes?.[0];
}

function classify(e: unknown): { code: string; message: string } {
  if (e instanceof NearIntentsError) return { code: e.code, message: e.message };
  return { code: EC.INTERNAL_ERROR, message: msg(e) };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
