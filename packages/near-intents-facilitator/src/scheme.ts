/**
 * `NearIntentsExactScheme` — the facilitator-side x402 handler for balance-based
 * (NEAR Intents) exact payments. Coexists with `@x402/near`'s `exact` on the
 * same `near:mainnet` network; merchants advertise either or both.
 *
 * verify() runs the spec §4.3 pipeline (signature → fields → is_nonce_used →
 * balance → simulate), all gas-free view calls. settle() submits `execute_intents`
 * through the relayer (Case A) or publishes to the Solver Relay (Case B), keyed
 * for idempotency on `(signer_id, nonce)` so a re-settle replays the cached
 * receipt.
 */
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  classifyAccountId,
  decodeVersionedNonce,
  encodeVersionedNonce,
  fromBase64,
  INTENTS_CONTRACT_ID,
  IntentsVerifier,
  isVersionedNonce,
  NEAR_INTENTS_EXACT_SCHEME,
  NEAR_MAINNET_CAIP2,
  nearTxReceipt,
  parseIntentMessage,
  recoverSigner,
  simulationOk,
  toBase64,
  type Intent,
  type MultiPayload,
  type NearIntentsPaymentPayload,
  type NearIntentsSigner,
  type ParsedIntentMessage,
  type RecoveredSigner,
  type SolverRelayClient,
} from "@solvador/near-intents-core";
import { NearIntentsError, NearIntentsErrorCode as EC } from "./errors.js";
import { InMemoryNonceStore, type NonceStore } from "./nonce-store.js";
import { SaltWatcher } from "./salt-watcher.js";

export type NearIntentsExactSchemeConfig = {
  /** Relayer signer that submits `execute_intents`. */
  signer: NearIntentsSigner;
  /** View-call client against `intents.near`. */
  verifier: IntentsVerifier;
  /** Idempotency + issued-nonce store (default in-memory). */
  nonceStore?: NonceStore;
  /** Salt cache (default built from `verifier`). */
  saltWatcher?: SaltWatcher;
  /** Solver Relay client — enables Case B (any-token-in). */
  solverRelay?: SolverRelayClient;
  /** Network id (default `near:mainnet`). */
  network?: string;
  /** Verifying contract (default `intents.near`). */
  verifyingContract?: string;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Case B: how long to poll the relay for SETTLED, ms (default 30s). */
  caseBTimeoutMs?: number;
};

export class NearIntentsExactScheme implements SchemeNetworkFacilitator {
  readonly scheme = NEAR_INTENTS_EXACT_SCHEME;
  readonly caipFamily = "near:*";

  private readonly signer: NearIntentsSigner;
  private readonly verifier: IntentsVerifier;
  private readonly nonceStore: NonceStore;
  readonly saltWatcher: SaltWatcher;
  private readonly solverRelay?: SolverRelayClient;
  private readonly network: string;
  private readonly verifyingContract: string;
  private readonly now: () => number;
  private readonly caseBTimeoutMs: number;

  constructor(config: NearIntentsExactSchemeConfig) {
    this.now = config.now ?? Date.now;
    this.signer = config.signer;
    this.verifier = config.verifier;
    this.nonceStore = config.nonceStore ?? new InMemoryNonceStore();
    // Share the scheme's clock with the salt watcher so `saltExpiresAt` and
    // deadline math agree (important when a fixed clock is injected in tests).
    this.saltWatcher = config.saltWatcher ?? new SaltWatcher(config.verifier, { now: this.now });
    this.solverRelay = config.solverRelay;
    this.network = config.network ?? NEAR_MAINNET_CAIP2;
    this.verifyingContract = config.verifyingContract ?? INTENTS_CONTRACT_ID;
    this.caseBTimeoutMs = config.caseBTimeoutMs ?? 30_000;
  }

  /** No client-supplied `extra` is required; the relayer is facilitator-local. */
  getExtra(_network: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /** Relayer account ids, advertised so clients see who sponsors gas. */
  getSigners(_network: string): string[] {
    return [...this.signer.getRelayerIds()];
  }

  /** The store, for the nonce-issuance endpoint and reconciliation. */
  get nonces(): NonceStore {
    return this.nonceStore;
  }

  /**
   * Issue a fresh versioned nonce for a merchant to embed in
   * `PaymentRequirements.extra.nonce`. Embeds the current salt and a deadline
   * `maxTimeoutSeconds` out, and records it as `issued`.
   */
  async issueNonce(
    maxTimeoutSeconds = 300,
  ): Promise<{ nonce: string; saltExpiresAt: number; deadline: string }> {
    const salt = await this.saltWatcher.currentSalt();
    const deadlineMs = this.now() + maxTimeoutSeconds * 1000;
    const nonce = toBase64(encodeVersionedNonce({ salt, deadline: deadlineMs }));
    await this.nonceStore.issue(nonce, deadlineMs);
    return {
      nonce,
      saltExpiresAt: this.saltWatcher.saltExpiresAt(),
      deadline: new Date(deadlineMs).toISOString(),
    };
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    try {
      const { parsed } = await this.runVerifyPipeline(payload, requirements);
      return { isValid: true, payer: parsed.signerId, extra: { standard: parsed.standard } };
    } catch (e) {
      return this.invalid(e);
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    let parsed: ParsedIntentMessage;
    try {
      // Re-run verification so settle is safe on its own (fail closed).
      ({ parsed } = await this.runVerifyPipeline(payload, requirements));
    } catch (e) {
      return this.settleFailure(e);
    }

    const mp = (payload.payload as NearIntentsPaymentPayload).multiPayload;
    const quoteHashes = (payload.payload as NearIntentsPaymentPayload).quoteHashes;
    const deadlineMs = this.deadlineMs(parsed) ?? this.now() + 300_000;

    // Idempotency + concurrent-dup gate, keyed on (signer_id, nonce).
    const claim = await this.nonceStore.beginSettle(parsed.nonce, {
      signerId: parsed.signerId,
      ...(requirements.extra?.paymentId ? { paymentId: String(requirements.extra.paymentId) } : {}),
      deadline: deadlineMs,
    });
    if (claim.kind === "replay" && claim.record.receipt) {
      return this.settled(claim.record.transaction ?? "", parsed, requirements, claim.record.receipt);
    }
    if (claim.kind === "in-flight") {
      return this.settleFailure(new NearIntentsError(EC.INTERNAL_ERROR, "settlement already in progress"));
    }

    try {
      const result =
        quoteHashes && quoteHashes.length > 0
          ? await this.settleCaseB(mp, quoteHashes, parsed, requirements)
          : await this.settleCaseA(mp, parsed, requirements);
      await this.nonceStore.completeSettle(parsed.nonce, {
        transaction: result.transaction,
        receipt: result.receipt,
      });
      return this.settled(result.transaction, parsed, requirements, result.receipt);
    } catch (e) {
      await this.nonceStore.failSettle(parsed.nonce).catch(() => {});
      return this.settleFailure(e);
    }
  }

  // ── verify pipeline ─────────────────────────────────────────────────────────

  private async runVerifyPipeline(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ parsed: ParsedIntentMessage; recovered: RecoveredSigner }> {
    const body = payload.payload as NearIntentsPaymentPayload | undefined;
    if (!body || typeof body !== "object" || !body.multiPayload) {
      throw new NearIntentsError(EC.MALFORMED_PAYLOAD, "missing payload.multiPayload");
    }
    const mp: MultiPayload = body.multiPayload;

    // 1) signature
    const recovered = recoverSigner(mp);
    if (!recovered.valid) throw new NearIntentsError(EC.INVALID_SIGNATURE, "signature did not verify");

    // parse the signed message
    let parsed: ParsedIntentMessage;
    try {
      parsed = parseIntentMessage(mp);
    } catch (e) {
      throw new NearIntentsError(EC.MALFORMED_PAYLOAD, msg(e));
    }

    // 2) fields
    if (!(await this.authorize(parsed.signerId, recovered))) {
      throw new NearIntentsError(EC.SIGNER_MISMATCH, "signer not authorized for signer_id");
    }
    if (parsed.verifyingContract !== this.verifyingContract) {
      throw new NearIntentsError(EC.WRONG_VERIFYING_CONTRACT, parsed.verifyingContract);
    }
    const issuedNonce = requirements.extra?.nonce;
    if (typeof issuedNonce === "string" && issuedNonce !== parsed.nonce) {
      throw new NearIntentsError(EC.NONCE_MISMATCH, "signed nonce ≠ issued nonce");
    }
    const dl = this.deadlineMs(parsed);
    if (dl !== undefined && dl < this.now()) {
      throw new NearIntentsError(EC.DEADLINE_EXCEEDED, parsed.deadline);
    }
    const payment = validatePayment(parsed.intents, requirements, Boolean(body.quoteHashes?.length));

    // salt freshness (versioned nonces only)
    const nonceBytes = fromBase64(parsed.nonce);
    if (isVersionedNonce(nonceBytes)) {
      const decoded = decodeVersionedNonce(nonceBytes)!;
      if (!(await this.saltWatcher.isValidSalt(decoded.saltHex))) {
        throw new NearIntentsError(EC.STALE_SALT, `salt ${decoded.saltHex} rotated`);
      }
    }

    // 3) is_nonce_used
    const used = await this.safeView(
      () => this.verifier.isNonceUsed(parsed.signerId, parsed.nonce),
      EC.UPSTREAM_ERROR,
    );
    if (used) throw new NearIntentsError(EC.NONCE_ALREADY_USED, parsed.nonce);

    // 4) balance
    const balances = await this.safeView(
      () => this.verifier.mtBatchBalanceOf(parsed.signerId, [payment.inputAsset]),
      EC.UPSTREAM_ERROR,
    );
    const balance = balances[0] ?? 0n;
    if (balance < payment.inputAmount) {
      throw new NearIntentsError(
        EC.INSUFFICIENT_FUNDS,
        `balance ${balance} < required ${payment.inputAmount} of ${payment.inputAsset}`,
      );
    }

    // 5) simulate
    const sim = await this.safeView(() => this.verifier.simulateIntents([mp]), EC.UPSTREAM_ERROR);
    if (!simulationOk(sim)) throw new NearIntentsError(EC.SIMULATION_FAILED, "invariant violated");

    return { parsed, recovered };
  }

  /** Is the recovered key authorized for `signerId`? (implicit match or has_public_key.) */
  private async authorize(signerId: string, recovered: RecoveredSigner): Promise<boolean> {
    if (!recovered.valid) return false;
    const kind = classifyAccountId(signerId);
    if (recovered.curve === "ed25519") {
      if (kind === "near-implicit") return signerId === recovered.accountId;
      if (kind === "named") return this.hasKey(signerId, recovered.publicKeyString);
      return false;
    }
    // secp256k1
    if (kind === "eth-implicit") return signerId.toLowerCase() === recovered.address.toLowerCase();
    if (kind === "named") return this.hasKey(signerId, recovered.publicKeyString);
    return false;
  }

  private async hasKey(accountId: string, publicKey: string): Promise<boolean> {
    return this.safeView(() => this.verifier.hasPublicKey(accountId, publicKey), EC.UPSTREAM_ERROR);
  }

  // ── settle paths ──────────────────────────────────────────────────────────

  private async settleCaseA(
    mp: MultiPayload,
    parsed: ParsedIntentMessage,
    requirements: PaymentRequirements,
  ): Promise<{ transaction: string; receipt: ReturnType<typeof nearTxReceipt> }> {
    const outcome = await this.signer.executeIntents([mp]);
    if (!outcome.success) {
      throw new NearIntentsError(EC.RELAYER_ERROR, `execute_intents failed (${outcome.transactionHash})`);
    }
    return {
      transaction: outcome.transactionHash,
      receipt: nearTxReceipt({
        transactionHash: outcome.transactionHash,
        relayerId: outcome.relayerId,
        signerId: parsed.signerId,
        payTo: requirements.payTo,
        amount: requirements.amount,
        asset: requirements.asset,
        nonce: parsed.nonce,
        ...(requirements.extra?.paymentId ? { paymentId: String(requirements.extra.paymentId) } : {}),
        network: this.network,
      }),
    };
  }

  private async settleCaseB(
    mp: MultiPayload,
    quoteHashes: string[],
    parsed: ParsedIntentMessage,
    requirements: PaymentRequirements,
  ): Promise<{ transaction: string; receipt: ReturnType<typeof nearTxReceipt> }> {
    if (!this.solverRelay) throw new NearIntentsError(EC.NO_QUOTE, "Case B not enabled (no solverRelay)");
    const published = await this.solverRelay.publishIntent({ quote_hashes: quoteHashes, signed_data: mp });
    if (published.status !== "OK") {
      const code = /expire/i.test(published.reason ?? "") ? EC.QUOTE_EXPIRED : EC.RELAYER_ERROR;
      throw new NearIntentsError(code, published.reason ?? "publish_intent failed");
    }
    const txHash = await this.pollSettled(published.intent_hash);
    return {
      transaction: txHash,
      receipt: nearTxReceipt({
        transactionHash: txHash,
        signerId: parsed.signerId,
        payTo: requirements.payTo,
        amount: requirements.amount,
        asset: requirements.asset,
        nonce: parsed.nonce,
        ...(requirements.extra?.paymentId ? { paymentId: String(requirements.extra.paymentId) } : {}),
        network: this.network,
      }),
    };
  }

  /** Poll the Solver Relay until SETTLED (or timeout), returning the NEAR tx hash. */
  private async pollSettled(intentHash: string): Promise<string> {
    const relay = this.solverRelay!;
    const deadline = this.now() + this.caseBTimeoutMs;
    for (;;) {
      const status = await relay.getStatus(intentHash);
      if (status.status === "SETTLED") return status.data?.hash ?? intentHash;
      if (status.status === "NOT_FOUND_OR_NOT_VALID") {
        throw new NearIntentsError(EC.RELAYER_ERROR, "intent not valid at relay");
      }
      if (this.now() >= deadline) throw new NearIntentsError(EC.RELAYER_ERROR, "settle timed out");
      await sleep(1_000);
    }
  }

  // ── response builders ───────────────────────────────────────────────────────

  private settled(
    transaction: string,
    parsed: ParsedIntentMessage,
    requirements: PaymentRequirements,
    receipt: unknown,
  ): SettleResponse {
    return {
      success: true,
      payer: parsed.signerId,
      transaction,
      network: this.network as SettleResponse["network"],
      amount: requirements.amount,
      extra: { receipt },
    };
  }

  private invalid(e: unknown): VerifyResponse {
    const { code, message } = classify(e);
    return { isValid: false, invalidReason: code, invalidMessage: message, extra: { retriable: isRetriableCode(code) } };
  }

  private settleFailure(e: unknown): SettleResponse {
    const { code, message } = classify(e);
    return {
      success: false,
      errorReason: code,
      errorMessage: message,
      transaction: "",
      network: this.network as SettleResponse["network"],
      extra: { retriable: isRetriableCode(code) },
    };
  }

  /** Extract a parseable deadline (epoch ms) from the message, or undefined. */
  private deadlineMs(parsed: ParsedIntentMessage): number | undefined {
    const t = Date.parse(parsed.deadline);
    return Number.isNaN(t) ? undefined : t;
  }

  /** Run a view thunk, converting any throw into a fail-closed NearIntentsError. */
  private async safeView<T>(fn: () => Promise<T>, code: (typeof EC)[keyof typeof EC]): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new NearIntentsError(code, msg(e));
    }
  }
}

// ── payment-content validation ─────────────────────────────────────────────────

export type ValidatedPayment = {
  case: "A" | "B";
  inputAsset: string;
  inputAmount: bigint;
};

/**
 * Validate that `intents` actually pays the merchant. Case A: a single `transfer`
 * of `asset`:`amount` to `payTo`. Case B: a `token_diff` (funding leg) plus a
 * `transfer` of `asset`:`amount` to `payTo`; the input is the diff's negative leg.
 */
export function validatePayment(
  intents: Intent[],
  requirements: PaymentRequirements,
  isCaseB: boolean,
): ValidatedPayment {
  const required = BigInt(requirements.amount);
  const transfer = intents.find(
    (i): i is Extract<Intent, { intent: "transfer" }> =>
      i.intent === "transfer" && (i as { receiver_id?: string }).receiver_id === requirements.payTo,
  );
  if (!transfer) throw new NearIntentsError(EC.WRONG_RECIPIENT, `no transfer to ${requirements.payTo}`);
  const moved = transfer.tokens?.[requirements.asset];
  if (moved === undefined) throw new NearIntentsError(EC.WRONG_ASSET, requirements.asset);
  if (BigInt(moved) !== required) throw new NearIntentsError(EC.WRONG_AMOUNT, `${moved} ≠ ${required}`);

  if (!isCaseB) return { case: "A", inputAsset: requirements.asset, inputAmount: required };

  const diff = intents.find(
    (i): i is Extract<Intent, { intent: "token_diff" }> => i.intent === "token_diff",
  );
  if (!diff) throw new NearIntentsError(EC.MALFORMED_PAYLOAD, "Case B requires a token_diff");
  const negatives = Object.entries(diff.diff).filter(([, v]) => BigInt(v) < 0n);
  const first = negatives[0];
  if (negatives.length !== 1 || !first) {
    throw new NearIntentsError(EC.MALFORMED_PAYLOAD, "token_diff must have exactly one input token");
  }
  return { case: "B", inputAsset: first[0], inputAmount: -BigInt(first[1]) };
}

function classify(e: unknown): { code: string; message: string } {
  if (e instanceof NearIntentsError) return { code: e.code, message: e.message };
  return { code: EC.INTERNAL_ERROR, message: msg(e) };
}

function isRetriableCode(code: string): boolean {
  return code === EC.STALE_SALT || code === EC.QUOTE_EXPIRED;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
