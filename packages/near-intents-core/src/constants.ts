/**
 * Network + contract + token constants for NEAR Intents mainnet.
 *
 * NEAR Intents has no testnet (the Verifier is mainnet-only); pre-production is
 * dust-amount mainnet plus `simulate_intents`. Everything here is mainnet.
 */

/** CAIP-2 network id, matching `@x402/near`'s `NEAR_MAINNET_CAIP2`. */
export const NEAR_MAINNET_CAIP2 = "near:mainnet";

/** x402 scheme string for balance-based (Intents) exact payments. */
export const NEAR_INTENTS_EXACT_SCHEME = "near-intents-exact";

/**
 * x402 scheme string for 1Click send-to-pay: the payer funds a one-time 1Click
 * deposit address on any supported origin chain; 1Click swaps/bridges and
 * delivers the exact amount directly to the merchant (EXACT_OUTPUT). Async
 * settlement — proof is 1Click's signed status. Named for what it does (pay
 * from any chain, exact delivery), not for the vendor plumbing.
 */
export const MULTICHAIN_EXACT_SCHEME = "multichain-exact";

/** The Verifier ("Defuse") contract every intent is addressed to. */
export const INTENTS_CONTRACT_ID = "intents.near";

/** wrap.near — the wrapped-NEAR NEP-141 used by `native_withdraw`. */
export const WRAP_NEAR = "wrap.near";

/** Default keyless NEAR RPC (FastNEAR), matching the Solvador facilitator default. */
export const DEFAULT_NEAR_RPC_URL = "https://rpc.mainnet.fastnear.com";

/** 1Click REST base URL. */
export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com";

/** Solver Relay JSON-RPC endpoint. */
export const SOLVER_RELAY_URL = "https://solver-relay-v2.chaindefuser.com/rpc";

/**
 * Canonical NEP-141 token ids on NEAR Intents. `usdc.near` is NOT the real
 * contract — Circle's native USDC lives at the hashed account below (6 dp).
 */
export const TOKEN_IDS = {
  /** Circle native USDC on NEAR (6 decimals). */
  USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  /** Tether USDT on NEAR (6 decimals). */
  USDT: "nep141:usdt.tether-token.near",
  /** wrapped NEAR (24 decimals). */
  WNEAR: "nep141:wrap.near",
} as const;

/** The `nep141:` multi-token id for a NEP-141 contract account. */
export function nep141TokenId(contractId: string): string {
  return `nep141:${contractId}`;
}

/** Extract the NEP-141 contract account from a `nep141:<contract>` token id. */
export function nep141ContractOf(tokenId: string): string {
  if (!tokenId.startsWith("nep141:")) throw new Error(`Not a nep141 token id: ${tokenId}`);
  return tokenId.slice("nep141:".length);
}

/** Gas for an `execute_intents` call (300 TGas, the max). Relayer pays it. */
export const EXECUTE_INTENTS_GAS = 300_000_000_000_000n;

/** `execute_intents` needs no attached deposit. */
export const EXECUTE_INTENTS_DEPOSIT = 0n;
