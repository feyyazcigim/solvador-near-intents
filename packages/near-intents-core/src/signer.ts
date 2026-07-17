/**
 * Relayer signer: submits `execute_intents` to `intents.near` and reports the
 * outcome. The relayer account pays gas; it is facilitator-local config and is
 * never taken from the client payload.
 *
 * `execute_intents({ signed })` is a change method with no attached deposit. We
 * build it with `@near-js/*` (the reference tx Borsh machinery) so nonce /
 * block-hash / signing / broadcast are handled correctly, and wait for FINAL by
 * default (matching the `@x402/near` settle path).
 */
import { Account } from "@near-js/accounts";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider, type Provider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators } from "@near-js/transactions";
import type { TxExecutionStatus } from "@near-js/types";
import {
  DEFAULT_NEAR_RPC_URL,
  EXECUTE_INTENTS_DEPOSIT,
  EXECUTE_INTENTS_GAS,
  INTENTS_CONTRACT_ID,
} from "./constants.js";
import type { MultiPayload } from "./payload.js";

/** Outcome of submitting `execute_intents`. */
export type ExecuteIntentsResult = {
  /** Outer transaction hash. */
  transactionHash: string;
  /** True iff the transaction executed successfully (no `Failure` status). */
  success: boolean;
  /** The relayer account that submitted it. */
  relayerId: string;
  /** `EVENT_JSON:`-prefixed logs collected across receipts (DIP-4 / NEP-297). */
  logs: string[];
  /** Raw execution status (`{ SuccessValue }` or `{ Failure }`). */
  status: unknown;
  /** Raw FinalExecutionOutcome for callers that need receipts. */
  outcome: unknown;
};

/** A relayer this facilitator controls. */
export type RelayerConfig = {
  accountId: string;
  /** Full-access secret key, `ed25519:...`. */
  secretKey: string;
};

export type CreateRelayerSignerOptions = {
  relayers: RelayerConfig[];
  /** RPC url; ignored if `provider` is supplied. */
  rpcUrl?: string;
  /** Injectable provider (tests / shared instance). */
  provider?: Provider;
  /** Gas per call (default 300 TGas). */
  gas?: bigint;
  /** Finality to wait for (default `FINAL`). */
  waitUntil?: TxExecutionStatus;
  /** Verifier contract id (default `intents.near`). */
  contractId?: string;
};

/** Facilitator-side signer abstraction (mirrors `@x402/near`'s reuse pattern). */
export interface NearIntentsSigner {
  readonly accountId: string;
  getRelayerIds(): string[];
  executeIntents(signed: MultiPayload[]): Promise<ExecuteIntentsResult>;
}

/**
 * Build a relayer signer over one or more relayer accounts. Calls round-robin
 * across relayers for basic load-spreading; each gets its own `Account`.
 */
export function createRelayerSigner(options: CreateRelayerSignerOptions): NearIntentsSigner {
  if (options.relayers.length === 0) throw new Error("createRelayerSigner: no relayers");
  const provider = options.provider ?? new JsonRpcProvider({ url: options.rpcUrl ?? DEFAULT_NEAR_RPC_URL });
  const gas = options.gas ?? EXECUTE_INTENTS_GAS;
  const waitUntil: TxExecutionStatus = options.waitUntil ?? "FINAL";
  const contractId = options.contractId ?? INTENTS_CONTRACT_ID;

  const accounts = options.relayers.map((r) => {
    const signer = new KeyPairSigner(KeyPair.fromString(r.secretKey as KeyPairString));
    return { id: r.accountId, account: new Account(r.accountId, provider, signer) };
  });
  let cursor = 0;

  return {
    accountId: accounts[0]!.id,
    getRelayerIds: () => accounts.map((a) => a.id),
    async executeIntents(signed: MultiPayload[]): Promise<ExecuteIntentsResult> {
      const chosen = accounts[cursor % accounts.length]!;
      cursor++;
      const outcome = (await chosen.account.signAndSendTransaction({
        receiverId: contractId,
        actions: [
          actionCreators.functionCall("execute_intents", { signed }, gas, EXECUTE_INTENTS_DEPOSIT),
        ],
        waitUntil,
        throwOnFailure: false,
      })) as ExecutionOutcome;
      return parseOutcome(outcome, chosen.id);
    },
  };
}

/** Loosely-typed view of the fields we read off a FinalExecutionOutcome. */
type ExecutionOutcome = {
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string };
  status?: unknown;
  receipts_outcome?: Array<{ outcome?: { logs?: string[] } }>;
};

/** Extract tx hash, success, and logs from a FinalExecutionOutcome. */
export function parseOutcome(outcome: ExecutionOutcome, relayerId: string): ExecuteIntentsResult {
  const status = outcome.status;
  const success =
    !!status &&
    typeof status === "object" &&
    "SuccessValue" in (status as Record<string, unknown>);
  const logs: string[] = [];
  for (const r of outcome.receipts_outcome ?? []) {
    for (const l of r.outcome?.logs ?? []) logs.push(l);
  }
  return {
    transactionHash: outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? "",
    success,
    relayerId,
    logs,
    status,
    outcome,
  };
}
