/**
 * Confidential settlement (Phase 5) — gated behind `SOLVADOR_NEAR_CONFIDENTIAL`.
 *
 * Blocked externally on the Defuse partner invite, so everything here is
 * flag-gated: it compiles and merges before access arrives, and only executes
 * when `enabled` is true. Verify mode defaults to **optimistic settle** (spec
 * §5.4 Mode 2): trust the signed intent + 1Click, poll the deposit to a terminal
 * status, and emit a `oneclick-signed-status` receipt (amounts stay private; the
 * 1Click signature is the proof). Authenticated verify (Mode 1) is behind a
 * second flag and carries an account-level disclosure caveat.
 */
import {
  oneClickSignedStatusReceipt,
  type Confidentiality,
  type ExecutionStatusResponse,
  type OneClickClient,
  type OneClickSignedStatusReceipt,
  type OneClickStatus,
} from "@solvador/near-intents-core";

/** Terminal 1Click statuses. */
const TERMINAL: ReadonlySet<OneClickStatus> = new Set<OneClickStatus>([
  "SUCCESS",
  "REFUNDED",
  "FAILED",
]);

export type ConfidentialConfig = {
  /** Master flag (SOLVADOR_NEAR_CONFIDENTIAL). When false, this is inert. */
  enabled: boolean;
  /** 1Click client (partner JWT recommended — also removes the 0.2% fee). */
  oneClick: OneClickClient;
  /** Quote confidentiality level (`basic` | `advanced`). */
  confidentiality?: Confidentiality;
  /**
   * Mode 1 (authenticated verify) behind a second flag; default false =
   * Mode 2 (optimistic). Mode 1 discloses account-level info to 1Click — surface
   * this in the dashboard consent copy.
   */
  authenticatedVerify?: boolean;
  /** Poll timeout (ms) waiting for a terminal status (default 60s). */
  pollTimeoutMs?: number;
  /** Poll interval (ms) (default 2s). */
  pollIntervalMs?: number;
  /** Injectable clock/sleep (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type ConfidentialSettleResult = {
  status: OneClickStatus;
  success: boolean;
  receipt: OneClickSignedStatusReceipt;
};

export class ConfidentialSettlement {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: ConfidentialConfig) {
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Whether confidential settlement is switched on. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** The configured confidentiality level for quotes. */
  get confidentiality(): Confidentiality {
    return this.config.confidentiality ?? "basic";
  }

  /**
   * Optimistic settle: poll a 1Click deposit address to a terminal status and
   * build a signed-status receipt. `depositAddress` comes from a prior
   * confidential quote (the payer funded it via a signed transfer intent).
   *
   * @throws if confidential settlement is disabled.
   */
  async settleByDeposit(
    depositAddress: string,
    opts: { depositMemo?: string; paymentId?: string } = {},
  ): Promise<ConfidentialSettleResult> {
    if (!this.enabled) throw new Error("confidential settlement is disabled");
    const status = await this.pollToTerminal(depositAddress, opts.depositMemo);
    return {
      status: status.status,
      success: status.status === "SUCCESS",
      receipt: oneClickSignedStatusReceipt({
        depositAddress,
        statusResponse: status,
        ...(opts.paymentId ? { paymentId: opts.paymentId } : {}),
      }),
    };
  }

  /** Poll `GET /v0/status` until the status is terminal or the timeout elapses. */
  private async pollToTerminal(
    depositAddress: string,
    depositMemo?: string,
  ): Promise<ExecutionStatusResponse> {
    const timeout = this.now() + (this.config.pollTimeoutMs ?? 60_000);
    const interval = this.config.pollIntervalMs ?? 2_000;
    for (;;) {
      const status = await this.config.oneClick.getStatus(depositAddress, depositMemo);
      if (TERMINAL.has(status.status)) return status;
      if (this.now() >= timeout) return status; // return last-known (non-terminal) status
      await this.sleep(interval);
    }
  }
}
