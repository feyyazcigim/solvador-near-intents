/**
 * Cached client for `GET 1click.chaindefuser.com/v0/tokens`.
 *
 * This is the single source of truth for `assetId → decimals` (and price/chain),
 * so amount math and Case-B quoting never guess a token's precision. TTL ~10 min.
 */
import { ONECLICK_BASE_URL } from "./constants.js";

/** One element of the 1Click `/v0/tokens` response. */
export type OneClickToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
  coingeckoId?: string;
};

export type TokenListOptions = {
  baseUrl?: string;
  /** Cache TTL in ms (default 10 min). */
  ttlMs?: number;
  /** Optional partner JWT (also removes the 0.2% fee elsewhere). */
  jwt?: string;
  fetchImpl?: typeof fetch;
};

export class TokenList {
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly jwt?: string;
  private readonly fetchImpl: typeof fetch;
  private cache?: { at: number; byId: Map<string, OneClickToken>; all: OneClickToken[] };
  private inflight?: Promise<void>;

  constructor(options: TokenListOptions = {}) {
    this.baseUrl = options.baseUrl ?? ONECLICK_BASE_URL;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.jwt = options.jwt;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** All tokens, refreshing the cache if stale. */
  async all(now: number = Date.now()): Promise<OneClickToken[]> {
    await this.ensureFresh(now);
    return this.cache!.all;
  }

  /** Look up a token by its `assetId` (e.g. `nep141:wrap.near`). */
  async byAssetId(assetId: string, now: number = Date.now()): Promise<OneClickToken | undefined> {
    await this.ensureFresh(now);
    return this.cache!.byId.get(assetId);
  }

  /** Decimals for an asset id; throws if unknown. */
  async decimalsOf(assetId: string, now: number = Date.now()): Promise<number> {
    const t = await this.byAssetId(assetId, now);
    if (!t) throw new Error(`unknown token assetId: ${assetId}`);
    return t.decimals;
  }

  private async ensureFresh(now: number): Promise<void> {
    if (this.cache && now - this.cache.at < this.ttlMs) return;
    // Collapse concurrent refreshes into one request.
    if (!this.inflight) {
      this.inflight = this.refresh(now).finally(() => {
        this.inflight = undefined;
      });
    }
    await this.inflight;
  }

  private async refresh(now: number): Promise<void> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.jwt) headers.authorization = `Bearer ${this.jwt}`;
    const res = await this.fetchImpl(`${this.baseUrl}/v0/tokens`, { headers });
    if (!res.ok) {
      // Serve stale on failure rather than throwing mid-payment, if we have it.
      if (this.cache) return;
      throw new Error(`1Click /v0/tokens HTTP ${res.status}`);
    }
    const all = (await res.json()) as OneClickToken[];
    const byId = new Map(all.map((t) => [t.assetId, t]));
    this.cache = { at: now, byId, all };
  }
}
