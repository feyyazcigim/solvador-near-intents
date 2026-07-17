/**
 * One-call wiring for the Solvador facilitator. Keeps the touch on the solvador
 * repo tiny: build the scheme, register it, mount the nonce route.
 *
 * The nonce HTTP handler is typed structurally (no Express import) so this
 * package stays framework-free; an Express `Router` satisfies the shapes.
 */
import {
  createRelayerSigner,
  IntentsVerifier,
  NEAR_MAINNET_CAIP2,
  SolverRelayClient,
  type NearIntentsSigner,
  type RelayerConfig,
} from "@solvador/near-intents-core";
import type { SchemeNetworkFacilitator } from "@x402/core/types";
import { NearIntentsExactScheme, type NearIntentsExactSchemeConfig } from "./scheme.js";
import type { NonceStore } from "./nonce-store.js";

/** Just the `register` surface of `@x402/core`'s `x402Facilitator`. */
export interface RegisterableFacilitator {
  register(networks: string | string[], facilitator: SchemeNetworkFacilitator): unknown;
}

export type CreateNearIntentsSchemeOptions = {
  /** Relayer accounts (reuse the solvador NEAR relayer). */
  relayers: RelayerConfig[];
  /** NEAR RPC url (default FastNEAR). */
  rpcUrl?: string;
  /** Network id (default `near:mainnet`). */
  network?: string;
  /** Enable Case B by passing Solver Relay options; omit/`false` to disable. */
  solverRelay?: { url?: string; apiKey?: string } | false;
  /** Persistent nonce/idempotency store (default in-memory). */
  nonceStore?: NonceStore;
  /** Override the relayer signer (tests). */
  signer?: NearIntentsSigner;
  /** Extra scheme config passthrough. */
  scheme?: Partial<NearIntentsExactSchemeConfig>;
};

/** Build a fully-wired {@link NearIntentsExactScheme} from flat config. */
export function createNearIntentsScheme(opts: CreateNearIntentsSchemeOptions): NearIntentsExactScheme {
  const network = opts.network ?? NEAR_MAINNET_CAIP2;
  const verifier = new IntentsVerifier({ ...(opts.rpcUrl ? { url: opts.rpcUrl } : {}) });
  const signer =
    opts.signer ??
    createRelayerSigner({ relayers: opts.relayers, ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}) });
  const solverRelay =
    opts.solverRelay === false || opts.solverRelay === undefined
      ? undefined
      : new SolverRelayClient(opts.solverRelay);
  return new NearIntentsExactScheme({
    signer,
    verifier,
    network,
    ...(solverRelay ? { solverRelay } : {}),
    ...(opts.nonceStore ? { nonceStore: opts.nonceStore } : {}),
    ...opts.scheme,
  });
}

export type RegisterNearIntentsOptions = CreateNearIntentsSchemeOptions & {
  /** Provide a pre-built scheme instead of constructing one. */
  prebuilt?: NearIntentsExactScheme;
};

export type RegisterNearIntentsResult = {
  scheme: NearIntentsExactScheme;
  /** Express-compatible handler for the nonce endpoint. */
  nonceHandler: NonceRouteHandler;
  /** The route path to mount `nonceHandler` at. */
  noncePath: string;
};

/**
 * Register `near-intents-exact` on the facilitator and return the scheme plus a
 * ready-to-mount nonce handler. Solvador wiring becomes:
 *
 *   const { nonceHandler, noncePath } = registerNearIntents(baseFacilitator, {...});
 *   facilitatorRouter.get(noncePath, nonceHandler);
 */
export function registerNearIntents(
  facilitator: RegisterableFacilitator,
  opts: RegisterNearIntentsOptions,
): RegisterNearIntentsResult {
  const scheme = opts.prebuilt ?? createNearIntentsScheme(opts);
  facilitator.register(opts.network ?? NEAR_MAINNET_CAIP2, scheme);
  return {
    scheme,
    nonceHandler: createNonceRouteHandler(scheme),
    noncePath: `/schemes/${scheme.scheme}/nonce`,
  };
}

// ── nonce HTTP handler (framework-free structural typing) ──────────────────────

export interface NonceHttpRequest {
  query: Record<string, unknown>;
}
export interface NonceHttpResponse {
  status(code: number): NonceHttpResponse;
  json(body: unknown): unknown;
}
export type NonceRouteHandler = (req: NonceHttpRequest, res: NonceHttpResponse) => Promise<void>;

export type NonceHandlerOptions = {
  /** Default timeout when the request omits `maxTimeoutSeconds` (default 300). */
  defaultTimeoutSeconds?: number;
  /** Upper bound on requested timeout (default 600). */
  maxTimeoutSeconds?: number;
};

/** Build the `GET .../nonce` handler for a scheme. */
export function createNonceRouteHandler(
  scheme: NearIntentsExactScheme,
  opts: NonceHandlerOptions = {},
): NonceRouteHandler {
  const dflt = opts.defaultTimeoutSeconds ?? 300;
  const cap = opts.maxTimeoutSeconds ?? 600;
  return async (req, res) => {
    const raw = Array.isArray(req.query.maxTimeoutSeconds)
      ? req.query.maxTimeoutSeconds[0]
      : req.query.maxTimeoutSeconds;
    const parsed = Number.parseInt(String(raw ?? ""), 10);
    const maxTimeoutSeconds = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, cap) : dflt;
    try {
      res.json(await scheme.issueNonce(maxTimeoutSeconds));
    } catch (e) {
      res.status(503).json({ error: e instanceof Error ? e.message : "nonce issuance failed" });
    }
  };
}
