/**
 * Solver Relay JSON-RPC client (Case B: any-token-in).
 *
 * Flow: `quote` (fan-out to solvers, ~3s) → pick an offer → sign a
 * `token_diff`(+`transfer`) MultiPayload whose diff matches the offer →
 * `publish_intent({ quote_hashes, signed_data })` → poll `get_status`.
 *
 * Endpoint + method shapes confirmed against docs.near-intents.org (Solver Relay
 * / message-bus API). Auth is a partner `X-API-Key`.
 */
import { SOLVER_RELAY_URL } from "./constants.js";
import type { MultiPayload } from "./payload.js";

/** A single solver offer from `quote`. */
export type SolverQuote = {
  quote_hash: string;
  defuse_asset_identifier_in: string;
  defuse_asset_identifier_out: string;
  amount_in: string;
  amount_out: string;
  expiration_time: string;
};

export type QuoteParams = {
  defuse_asset_identifier_in: string;
  defuse_asset_identifier_out: string;
  /** Exactly one of exact_amount_in / exact_amount_out. */
  exact_amount_in?: string;
  exact_amount_out?: string;
  /** Min ms the quote must stay valid (default server-side 60000). */
  min_deadline_ms?: number;
};

export type PublishIntentParams = {
  quote_hashes: string[];
  signed_data: MultiPayload;
};

export type PublishIntentResult = {
  status: "OK" | "FAILED" | string;
  intent_hash: string;
  reason?: string;
};

/** Solver-relay intent status (distinct from 1Click's status enum). */
export type IntentStatus = {
  intent_hash: string;
  status: "PENDING" | "TX_BROADCASTED" | "SETTLED" | "NOT_FOUND_OR_NOT_VALID" | string;
  data?: { hash?: string };
};

export type SolverRelayOptions = {
  url?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

export class SolverRelayError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "SolverRelayError";
  }
}

export class SolverRelayClient {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private id = 0;

  constructor(options: SolverRelayOptions = {}) {
    this.url = options.url ?? SOLVER_RELAY_URL;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Request solver quotes. Returns `[]` when no solver responds. */
  async quote(params: QuoteParams): Promise<SolverQuote[]> {
    if ((params.exact_amount_in === undefined) === (params.exact_amount_out === undefined)) {
      throw new Error("quote: provide exactly one of exact_amount_in / exact_amount_out");
    }
    const result = await this.call<SolverQuote[] | null>("quote", [params]);
    return result ?? [];
  }

  /** Publish a signed intent bound to one or more quote hashes. */
  async publishIntent(params: PublishIntentParams): Promise<PublishIntentResult> {
    return this.call<PublishIntentResult>("publish_intent", [params]);
  }

  /** Poll an intent's settlement status. `data.hash` is the settling NEAR tx. */
  async getStatus(intentHash: string): Promise<IntentStatus> {
    return this.call<IntentStatus>("get_status", [{ intent_hash: intentHash }]);
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: ++this.id, jsonrpc: "2.0", method, params }),
    });
    if (!res.ok) throw new SolverRelayError(`solver-relay HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: unknown };
    if (body.error !== undefined) throw new SolverRelayError(`solver-relay ${method} error`, body.error);
    return body.result as T;
  }
}

/** Choose the offer with the largest `amount_out` (best for the payer). */
export function bestQuote(quotes: SolverQuote[]): SolverQuote | undefined {
  return quotes.reduce<SolverQuote | undefined>((best, q) => {
    if (!best) return q;
    return BigInt(q.amount_out) > BigInt(best.amount_out) ? q : best;
  }, undefined);
}
