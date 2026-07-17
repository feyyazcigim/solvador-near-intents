/**
 * Merchant-side (resource-server) x402 plugin for `multichain-exact` — the
 * 1Click send-to-pay scheme. What a merchant server registers with
 * `x402ResourceServer` so the Express middleware can advertise it:
 *
 *  - `parsePrice` — "$0.01" → atomic native-NEAR USDC (6 dp, EXACT_OUTPUT:
 *    exactly what the merchant receives, delivered directly to `payTo`).
 *  - `enhancePaymentRequirements` — copies the facilitator-advertised
 *    `quotePath` (from /supported `kinds[].extra`) into `extra`, plus the
 *    suggested origin asset for the paywall. All static — no per-402 fetch, no
 *    nonce dance: the payer pulls their own quote (with THEIR refund address)
 *    from the facilitator's open quote endpoint.
 */
import { toAtomicUnits, MULTICHAIN_EXACT_SCHEME, TOKEN_IDS } from "@solvador/near-intents-core";
import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";

export const SCHEME = MULTICHAIN_EXACT_SCHEME;
export const NETWORK = "near:mainnet";

/** What the merchant receives: Circle native USDC on NEAR (6 dp). */
export const DESTINATION_ASSET = TOKEN_IDS.USDC;
export const USDC_DECIMALS = 6;

/** Suggested origin for the paywall: Circle USDC on Base (payer can override). */
export const DEFAULT_ORIGIN_ASSET =
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

export type MultichainExactServerSchemeOptions = {
  /** Asset advertised for `$`-denominated prices (default native NEAR USDC). */
  asset?: string;
  /** Decimals of that asset (default 6). */
  decimals?: number;
  /** Origin asset suggested to payers (default Base USDC). */
  defaultOriginAsset?: string;
};

export class MultichainExactServerScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME;
  private readonly asset: string;
  private readonly decimals: number;
  private readonly defaultOriginAsset: string;

  constructor(options: MultichainExactServerSchemeOptions = {}) {
    this.asset = options.asset ?? DESTINATION_ASSET;
    this.decimals = options.decimals ?? USDC_DECIMALS;
    this.defaultOriginAsset = options.defaultOriginAsset ?? DEFAULT_ORIGIN_ASSET;
  }

  /** "$0.01" / 0.01 / "0.01" → atomic USDC; an AssetAmount passes through. */
  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price && "asset" in price) {
      return price;
    }
    const decimal = String(price).trim().replace(/^\$/, "");
    return { amount: toAtomicUnits(decimal, this.decimals).toString(), asset: this.asset };
  }

  getAssetDecimals(_asset: string, _network: Network): number {
    return this.decimals;
  }

  /**
   * Static extra: the facilitator's quote endpoint (discovered from
   * /supported) and the suggested origin asset. Deterministic per route, so
   * requirement matching on the verify path stays exact.
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    const quotePath =
      typeof supportedKind.extra?.quotePath === "string"
        ? supportedKind.extra.quotePath
        : `/schemes/${this.scheme}/quote`;
    return {
      ...requirements,
      extra: {
        quotePath,
        originAsset: this.defaultOriginAsset,
        ...requirements.extra,
      },
    };
  }
}
