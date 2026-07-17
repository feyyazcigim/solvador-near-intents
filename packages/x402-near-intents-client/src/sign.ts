/**
 * Wallet-standard-aware signing: turn an {@link IntentMessageParams} into a
 * MultiPayload. ERC-191 signs the full DefusePayload; NEP-413 signs the reduced
 * message. Shared by the Case A scheme and the Case B builder.
 */
import {
  buildDefusePayloadJson,
  buildNep413MessageJson,
  erc191MultiPayloadFromHexSig,
  INTENTS_CONTRACT_ID,
  signNep413,
  type IntentMessageParams,
  type MultiPayload,
} from "@solvador/near-intents-core";
import type { NearIntentsClientWallet } from "./wallet.js";

/** Sign an intent message with the wallet's native standard. */
export async function signIntentMessage(
  wallet: NearIntentsClientWallet,
  params: IntentMessageParams,
): Promise<MultiPayload> {
  if (wallet.kind === "evm") {
    const message = buildDefusePayloadJson(params);
    const hexSig = await wallet.signPersonalMessage(message);
    return erc191MultiPayloadFromHexSig(message, hexSig);
  }
  const message = buildNep413MessageJson(params);
  return signNep413(
    { message, nonce: params.nonce, recipient: params.verifyingContract ?? INTENTS_CONTRACT_ID },
    wallet.secretKey,
  );
}
