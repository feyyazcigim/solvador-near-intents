/**
 * Payer-side x402 plugin for `multichain-exact` (1Click send-to-pay).
 *
 * Unlike `near-intents-exact`, there is nothing to sign: the payment IS the
 * funding of the one-time 1Click deposit address (a plain transfer on the
 * origin chain). The application performs the quote + transfer + status-poll
 * dance however it likes, then hands this scheme the deposit reference; the
 * scheme just formats it into the x402 payload for the paid request.
 */
import { MULTICHAIN_EXACT_SCHEME } from "@solvador/near-intents-core";
import type { PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";

/** The deposit reference presented as payment. */
export type MultichainDeposit = {
  depositAddress: string;
  depositMemo?: string;
  /** Origin-chain tx hash — lets the facilitator accelerate 1Click detection. */
  originTxHash?: string;
};

export class MultichainExactClientScheme implements SchemeNetworkClient {
  readonly scheme = MULTICHAIN_EXACT_SCHEME;

  constructor(
    private readonly deposit:
      | MultichainDeposit
      | ((requirements: PaymentRequirements) => Promise<MultichainDeposit> | MultichainDeposit),
  ) {}

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    const d = typeof this.deposit === "function" ? await this.deposit(requirements) : this.deposit;
    if (!d?.depositAddress) throw new Error("multichain-exact: no depositAddress provided");
    return {
      x402Version,
      payload: {
        depositAddress: d.depositAddress,
        ...(d.depositMemo ? { depositMemo: d.depositMemo } : {}),
        ...(d.originTxHash ? { originTxHash: d.originTxHash } : {}),
      },
    };
  }
}
