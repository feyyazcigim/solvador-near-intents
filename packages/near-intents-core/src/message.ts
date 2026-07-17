/**
 * Parse a signed MultiPayload back into its DefusePayload fields, and recover the
 * signer identity — the read/verify counterpart to `intents.ts` (which builds)
 * and `payload.ts` (which signs). Unifies the two message forms:
 *
 *  - nep413: fields split across the reduced `message` JSON and the envelope
 *    (`recipient` → verifying_contract, `nonce` → nonce).
 *  - erc191 / raw_ed25519: all fields inside the full DefusePayload JSON string.
 */
import { ed25519ToAccountId } from "./accounts.js";
import { toBase58 } from "./bytes.js";
import type { Intent } from "./intents.js";
import { type MultiPayload, verifyErc191, verifyNep413, verifyRawEd25519 } from "./payload.js";

/** DefusePayload fields extracted from a MultiPayload (regardless of standard). */
export type ParsedIntentMessage = {
  standard: MultiPayload["standard"];
  signerId: string;
  verifyingContract: string;
  deadline: string;
  /** base64 nonce. */
  nonce: string;
  intents: Intent[];
  /** The raw parsed message object. */
  message: Record<string, unknown>;
};

/** Parse the signed message of a MultiPayload. Throws on unsupported standards. */
export function parseIntentMessage(mp: MultiPayload): ParsedIntentMessage {
  if (mp.standard === "nep413") {
    const message = JSON.parse(mp.payload.message) as Record<string, unknown>;
    return {
      standard: mp.standard,
      signerId: String(message.signer_id ?? ""),
      verifyingContract: mp.payload.recipient,
      deadline: String(message.deadline ?? ""),
      nonce: mp.payload.nonce,
      intents: (message.intents as Intent[]) ?? [],
      message,
    };
  }
  if (mp.standard === "erc191" || mp.standard === "raw_ed25519") {
    const message = JSON.parse(mp.payload) as Record<string, unknown>;
    return {
      standard: mp.standard,
      signerId: String(message.signer_id ?? ""),
      verifyingContract: String(message.verifying_contract ?? ""),
      deadline: String(message.deadline ?? ""),
      nonce: String(message.nonce ?? ""),
      intents: (message.intents as Intent[]) ?? [],
      message,
    };
  }
  throw new Error(`parseIntentMessage: unsupported standard "${(mp as { standard: string }).standard}"`);
}

/** The verified signer identity recovered from a MultiPayload's signature. */
export type RecoveredSigner =
  | { valid: true; curve: "ed25519"; accountId: string; publicKeyString: string }
  | { valid: true; curve: "secp256k1"; address: string; publicKeyString: string }
  | { valid: false };

/**
 * Verify a MultiPayload's signature and recover the signer. For ed25519 the
 * recovered `accountId` is the NEAR-implicit id; for secp256k1 the `address` is
 * the ETH-implicit id. Fails closed.
 */
export function recoverSigner(mp: MultiPayload): RecoveredSigner {
  switch (mp.standard) {
    case "nep413": {
      const r = verifyNep413(mp);
      if (!r.valid || !r.publicKey || !r.publicKeyString) return { valid: false };
      return {
        valid: true,
        curve: "ed25519",
        accountId: ed25519ToAccountId(r.publicKey),
        publicKeyString: r.publicKeyString,
      };
    }
    case "raw_ed25519": {
      const r = verifyRawEd25519(mp);
      if (!r.valid || !r.publicKey) return { valid: false };
      return {
        valid: true,
        curve: "ed25519",
        accountId: ed25519ToAccountId(r.publicKey),
        publicKeyString: `ed25519:${toBase58(r.publicKey)}`,
      };
    }
    case "erc191": {
      const r = verifyErc191(mp);
      if (!r.valid || !r.address || !r.publicKeyString) return { valid: false };
      return { valid: true, curve: "secp256k1", address: r.address, publicKeyString: r.publicKeyString };
    }
    default:
      return { valid: false };
  }
}
