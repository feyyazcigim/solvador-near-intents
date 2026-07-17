/**
 * Nonce lifecycle + settle idempotency store.
 *
 * Backs two things:
 *  1. Issued-nonce tracking for the `GET .../nonce` endpoint (TTL-pruned).
 *  2. The settle idempotency key `(signer_id, nonce)` — a re-settle of the same
 *     payment returns the cached receipt instead of re-submitting, and a
 *     concurrent settle is rejected as in-flight.
 *
 * The interface is async so the Solvador facilitator can back it with the
 * `intents_nonces` Postgres collection (TTL index on `deadline`); the in-memory
 * default is correct for a single process because Node is single-threaded and
 * `beginSettle` performs its check-and-set with no interleaved `await`.
 */
import type { NearTxReceipt } from "@solvador/near-intents-core";

export type NonceStatus = "issued" | "settling" | "settled" | "failed";

export type NonceRecord = {
  /** base64 nonce (the key). */
  nonce: string;
  signerId?: string;
  paymentId?: string;
  status: NonceStatus;
  /** Epoch-ms deadline; the row is prunable after it passes. */
  deadline: number;
  transaction?: string;
  receipt?: NearTxReceipt;
};

/** Outcome of claiming a nonce for settlement. */
export type BeginSettleResult =
  | { kind: "proceed" }
  | { kind: "replay"; record: NonceRecord }
  | { kind: "in-flight"; record: NonceRecord };

export interface NonceStore {
  /** Record a freshly issued nonce (status `issued`) with its TTL deadline. */
  issue(nonce: string, deadline: number): Promise<void>;
  /** Fetch a nonce record. */
  get(nonce: string): Promise<NonceRecord | undefined>;
  /**
   * Atomically claim a nonce for settling. Returns `replay` (already settled,
   * with the cached receipt), `in-flight` (a settle is in progress), or
   * `proceed` (claimed — caller must finish with completeSettle/failSettle).
   */
  beginSettle(
    nonce: string,
    meta: { signerId: string; paymentId?: string; deadline: number },
  ): Promise<BeginSettleResult>;
  /** Mark a claimed nonce settled and store its receipt. */
  completeSettle(nonce: string, result: { transaction: string; receipt: NearTxReceipt }): Promise<void>;
  /** Release a claimed nonce after a failed settle so a retry can re-claim it. */
  failSettle(nonce: string): Promise<void>;
  /** Remove records whose deadline is older than `now`; returns the count removed. */
  prune(now: number): Promise<number>;
}

/** Single-process in-memory {@link NonceStore}. */
export class InMemoryNonceStore implements NonceStore {
  private readonly map = new Map<string, NonceRecord>();

  async issue(nonce: string, deadline: number): Promise<void> {
    if (!this.map.has(nonce)) this.map.set(nonce, { nonce, status: "issued", deadline });
  }

  async get(nonce: string): Promise<NonceRecord | undefined> {
    return this.map.get(nonce);
  }

  async beginSettle(
    nonce: string,
    meta: { signerId: string; paymentId?: string; deadline: number },
  ): Promise<BeginSettleResult> {
    const existing = this.map.get(nonce);
    if (existing?.status === "settled") return { kind: "replay", record: existing };
    if (existing?.status === "settling") return { kind: "in-flight", record: existing };
    // Claim (create or overwrite an `issued`/`failed` record).
    this.map.set(nonce, {
      nonce,
      signerId: meta.signerId,
      ...(meta.paymentId === undefined ? {} : { paymentId: meta.paymentId }),
      status: "settling",
      deadline: meta.deadline,
    });
    return { kind: "proceed" };
  }

  async completeSettle(
    nonce: string,
    result: { transaction: string; receipt: NearTxReceipt },
  ): Promise<void> {
    const rec = this.map.get(nonce);
    const base: NonceRecord = rec ?? { nonce, status: "settling", deadline: 0 };
    this.map.set(nonce, {
      ...base,
      status: "settled",
      transaction: result.transaction,
      receipt: result.receipt,
    });
  }

  async failSettle(nonce: string): Promise<void> {
    const rec = this.map.get(nonce);
    if (rec) this.map.set(nonce, { ...rec, status: "failed" });
  }

  async prune(now: number): Promise<number> {
    let removed = 0;
    for (const [key, rec] of this.map) {
      // Keep settled records (idempotency) a while past their deadline; prune the
      // rest once expired.
      if (rec.deadline < now && rec.status !== "settled") {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
