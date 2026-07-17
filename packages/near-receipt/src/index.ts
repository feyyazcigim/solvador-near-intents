/**
 * @solvador/near-receipt — merchant-side verification of NEAR Intents x402
 * receipts.
 *
 *  - {@link verifyNearTxReceipt} (public path): fetches the on-chain tx, asserts
 *    it is a successful `execute_intents` on `intents.near`, decodes the exact
 *    submitted intent, and matches the transfer to `payTo` for `asset`:`amount`.
 *    This decodes the *submitted args* (format-stable) rather than parsing event
 *    logs, so it can't be spoofed by a look-alike receipt object.
 *  - {@link verifyOneClickReceipt} (confidential path): checks the 1Click signed
 *    status is terminal-success and, when a verifying key is configured, checks
 *    the 1Click signature (Phase 5).
 */
import {
  bytesToUtf8,
  fromBase64,
  INTENTS_CONTRACT_ID,
  NearRpc,
  parseIntentMessage,
  type MultiPayload,
  type NearTxReceipt,
  type OneClickSignedStatusReceipt,
} from "@solvador/near-intents-core";

export type ReceiptVerification = {
  valid: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

export type VerifyNearTxOptions = {
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
  /** Override the expected recipient/amount/asset (default: the receipt's own). */
  payTo?: string;
  amount?: string;
  asset?: string;
  /** If set, require the decoded intent to carry this payment id (memo). */
  paymentId?: string;
};

/** Loosely-typed slice of a NEAR FinalExecutionOutcome we read. */
type TxOutcome = {
  status?: unknown;
  transaction?: {
    signer_id?: string;
    receiver_id?: string;
    actions?: Array<{ FunctionCall?: { method_name?: string; args?: string } }>;
  };
  receipts_outcome?: Array<{ outcome?: { logs?: string[] } }>;
};

/**
 * Verify a public `near-tx` receipt against the chain. Returns `{ valid, reason,
 * details }`; `valid: false` never throws for an expected negative (bad tx,
 * mismatch) — only unexpected transport issues surface as `reason`.
 */
export async function verifyNearTxReceipt(
  receipt: NearTxReceipt,
  options: VerifyNearTxOptions = {},
): Promise<ReceiptVerification> {
  if (receipt.kind !== "near-tx") return { valid: false, reason: "not a near-tx receipt" };
  if (!receipt.transactionHash) return { valid: false, reason: "receipt missing transactionHash" };
  if (!receipt.relayerId) {
    return { valid: false, reason: "receipt missing relayerId (needed as tx sender_account_id)" };
  }

  const rpc = new NearRpc({
    ...(options.rpcUrl ? { url: options.rpcUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  let outcome: TxOutcome;
  try {
    outcome = await rpc.rpc<TxOutcome>("tx", {
      tx_hash: receipt.transactionHash,
      sender_account_id: receipt.relayerId,
      wait_until: "FINAL",
    });
  } catch (e) {
    return { valid: false, reason: `tx fetch failed: ${msg(e)}` };
  }

  if (!isSuccessStatus(outcome.status)) return { valid: false, reason: "transaction did not succeed" };

  const tx = outcome.transaction;
  if (tx?.receiver_id !== INTENTS_CONTRACT_ID) {
    return { valid: false, reason: `receiver ${tx?.receiver_id} ≠ ${INTENTS_CONTRACT_ID}` };
  }
  const call = (tx.actions ?? [])
    .map((a) => a.FunctionCall)
    .find((f) => f?.method_name === "execute_intents");
  if (!call?.args) return { valid: false, reason: "no execute_intents action" };

  const payTo = options.payTo ?? receipt.payTo;
  const amount = options.amount ?? receipt.amount;
  const asset = options.asset ?? receipt.asset;

  let signed: MultiPayload[] | undefined;
  try {
    signed = (JSON.parse(bytesToUtf8(fromBase64(call.args))) as { signed?: MultiPayload[] }).signed;
  } catch {
    signed = undefined;
  }
  if (!Array.isArray(signed)) return { valid: false, reason: "could not decode execute_intents args" };

  const match = signed.some((mp) => {
    try {
      const parsed = parseIntentMessage(mp);
      if (parsed.signerId !== receipt.signerId) return false;
      const transfer = parsed.intents.find(
        (i) => i.intent === "transfer" && (i as { receiver_id?: string }).receiver_id === payTo,
      ) as { tokens?: Record<string, string> } | undefined;
      return transfer !== undefined && String(transfer.tokens?.[asset]) === String(amount);
    } catch {
      return false;
    }
  });
  if (!match) {
    return {
      valid: false,
      reason: "no submitted transfer intent matched payTo/asset/amount",
      details: { payTo, asset, amount, signerId: receipt.signerId },
    };
  }

  return {
    valid: true,
    details: { payTo, asset, amount, signerId: receipt.signerId, method: "execute_intents" },
  };
}

export type VerifyOneClickOptions = {
  /** Terminal statuses accepted as paid (default `["SUCCESS"]`). */
  acceptStatuses?: string[];
  /**
   * 1Click's verifying key. When set, the quote signature is checked (Phase 5).
   * The public key format is not yet documented, so this is a hook for now.
   */
  verifyingKey?: string;
  /** Custom signature verifier, given the receipt; overrides the built-in path. */
  verifySignature?: (receipt: OneClickSignedStatusReceipt) => boolean;
};

/**
 * Verify a confidential `oneclick-signed-status` receipt. Confirms the status is
 * terminal-success; verifies the 1Click signature when a verifier/key is
 * supplied. Without a key it returns valid on the structural check and notes the
 * signature was not cryptographically verified.
 */
export async function verifyOneClickReceipt(
  receipt: OneClickSignedStatusReceipt,
  options: VerifyOneClickOptions = {},
): Promise<ReceiptVerification> {
  if (receipt.kind !== "oneclick-signed-status") return { valid: false, reason: "not a 1Click receipt" };
  const accept = options.acceptStatuses ?? ["SUCCESS"];
  if (!accept.includes(receipt.status)) {
    return { valid: false, reason: `status ${receipt.status} is not terminal-success` };
  }
  if (!receipt.quoteSignature) return { valid: false, reason: "receipt missing quoteSignature" };

  if (options.verifySignature) {
    return options.verifySignature(receipt)
      ? { valid: true, details: { status: receipt.status, signatureVerified: true } }
      : { valid: false, reason: "1Click signature did not verify" };
  }

  return {
    valid: true,
    reason: options.verifyingKey
      ? "1Click signature format not yet documented; structural check only"
      : "no verifyingKey configured; structural check only",
    details: { status: receipt.status, signatureVerified: false },
  };
}

function isSuccessStatus(status: unknown): boolean {
  return !!status && typeof status === "object" && "SuccessValue" in (status as Record<string, unknown>);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
