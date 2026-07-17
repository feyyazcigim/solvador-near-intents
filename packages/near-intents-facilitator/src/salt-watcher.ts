/**
 * In-process cache over `intents.near`'s `current_salt`, refreshed on a TTL
 * (60s default). Versioned nonces embed a salt; when the contract rotates it,
 * outstanding nonces built against the old salt become invalid, and the client
 * must retry with a fresh one (a retriable `STALE_SALT`).
 *
 * `isValidSalt` prefers an on-chain `is_valid_salt` check (rotation keeps the
 * previous salt valid for a grace window), falling back to equality with the
 * cached current salt.
 */
import type { IntentsVerifier } from "@solvador/near-intents-core";

export type SaltWatcherOptions = {
  /** Cache TTL in ms (default 60s). */
  ttlMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
};

export class SaltWatcher {
  private readonly verifier: IntentsVerifier;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache?: { at: number; salt: string };
  private inflight?: Promise<string>;

  constructor(verifier: IntentsVerifier, options: SaltWatcherOptions = {}) {
    this.verifier = verifier;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** The current salt (hex), refreshing the cache if older than the TTL. */
  async currentSalt(): Promise<string> {
    const t = this.now();
    if (this.cache && t - this.cache.at < this.ttlMs) return this.cache.salt;
    if (!this.inflight) {
      this.inflight = this.verifier
        .currentSalt()
        .then((salt) => {
          this.cache = { at: this.now(), salt };
          return salt;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }

  /** When the cached salt would be considered stale (epoch ms) — advertised to clients. */
  saltExpiresAt(): number {
    return (this.cache?.at ?? this.now()) + this.ttlMs;
  }

  /**
   * Whether `salt` (hex) is still accepted on-chain. Uses `is_valid_salt` so a
   * just-rotated previous salt (still in its grace window) is honored; falls back
   * to equality with the cached current salt if that view is unavailable.
   */
  async isValidSalt(salt: string): Promise<boolean> {
    try {
      return await this.verifier.isValidSalt(salt);
    } catch {
      const current = await this.currentSalt().catch(() => undefined);
      return current !== undefined && current.toLowerCase() === salt.toLowerCase();
    }
  }
}
