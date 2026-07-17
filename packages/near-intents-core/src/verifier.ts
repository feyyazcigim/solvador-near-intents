/**
 * Read-side client for the `intents.near` Verifier: the exact view calls the
 * facilitator's verify pipeline needs, plus `simulate_intents` (a `&self`
 * method callable as a function-call view).
 *
 * Every method name / arg shape is confirmed against the `near/intents` source
 * (see per-method comments). All reads should be finality-pinned (`NearRpc`
 * defaults to `final`) so verification never races an un-final state.
 */
import { toBase64 } from "./bytes.js";
import { INTENTS_CONTRACT_ID } from "./constants.js";
import type { MultiPayload } from "./payload.js";
import { NearRpc, type NearRpcOptions } from "./rpc.js";

/** Result of `simulate_intents` (`SimulationOutput`). */
export type SimulationOutput = {
  intents_executed: Array<{ intent_hash?: string; account_id?: string; nonce?: string }>;
  logs: string[];
  min_deadline: string;
  /** Present iff the token deltas don't balance — the intent would be rejected. */
  invariant_violated?: unknown;
  state: {
    /** Protocol fee in pips (1 pip = 1e-6). */
    fee: number;
    /** Current 4-byte salt as hex. */
    current_salt: string;
    [key: string]: unknown;
  };
};

export class IntentsVerifier {
  private readonly rpc: NearRpc;
  readonly contractId: string;

  constructor(options: NearRpcOptions & { contractId?: string } = {}) {
    this.rpc = new NearRpc(options);
    this.contractId = options.contractId ?? INTENTS_CONTRACT_ID;
  }

  /** The underlying RPC (for callers that need `simulate`/custom views). */
  get rpcClient(): NearRpc {
    return this.rpc;
  }

  /**
   * `mt_batch_balance_of(account_id, token_ids) -> U128[]`. Balances are decimal
   * strings, index-aligned with `tokenIds`; returned here as `bigint`.
   */
  async mtBatchBalanceOf(accountId: string, tokenIds: string[]): Promise<bigint[]> {
    const balances = await this.rpc.viewFunction<string[]>(this.contractId, "mt_batch_balance_of", {
      account_id: accountId,
      token_ids: tokenIds,
    });
    return balances.map((b) => BigInt(b));
  }

  /** `mt_balance_of(account_id, token_id) -> U128`. */
  async mtBalanceOf(accountId: string, tokenId: string): Promise<bigint> {
    const [balance] = await this.mtBatchBalanceOf(accountId, [tokenId]);
    return balance ?? 0n;
  }

  /**
   * `is_nonce_used(account_id, nonce) -> bool`. `nonce` is base64 of the 32-byte
   * value; accepts either raw bytes or an already-base64 string.
   */
  async isNonceUsed(accountId: string, nonce: Uint8Array | string): Promise<boolean> {
    return this.rpc.viewFunction<boolean>(this.contractId, "is_nonce_used", {
      account_id: accountId,
      nonce: typeof nonce === "string" ? nonce : toBase64(nonce),
    });
  }

  /** `has_public_key(account_id, public_key) -> bool`. */
  async hasPublicKey(accountId: string, publicKey: string): Promise<boolean> {
    return this.rpc.viewFunction<boolean>(this.contractId, "has_public_key", {
      account_id: accountId,
      public_key: publicKey,
    });
  }

  /** `current_salt() -> Salt` (4-byte hex string, e.g. `"a1b2c3d4"`). */
  async currentSalt(): Promise<string> {
    return this.rpc.viewFunction<string>(this.contractId, "current_salt", {});
  }

  /** `is_valid_salt(salt) -> bool`. */
  async isValidSalt(salt: string): Promise<boolean> {
    return this.rpc.viewFunction<boolean>(this.contractId, "is_valid_salt", { salt });
  }

  /**
   * `simulate_intents(signed) -> SimulationOutput`. A `&self` view: no gas, no
   * state change. `invariant_violated` present ⇒ the intent would be rejected.
   */
  async simulateIntents(signed: MultiPayload[]): Promise<SimulationOutput> {
    return this.rpc.viewFunction<SimulationOutput>(this.contractId, "simulate_intents", { signed });
  }
}

/** True when a simulation reports a balanced, executable intent set. */
export function simulationOk(sim: SimulationOutput): boolean {
  return sim.invariant_violated === undefined || sim.invariant_violated === null;
}
