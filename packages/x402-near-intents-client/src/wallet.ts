/**
 * Wallet abstraction for the payer side. Deliberately minimal and
 * dependency-free so any wallet plugs in:
 *
 *  - **EVM**: supply `signPersonalMessage` (EIP-191 `personal_sign`) — every EVM
 *    wallet, viem, and ethers expose it. e.g. viem:
 *      `{ kind: "evm", address, signPersonalMessage: (m) =>
 *          walletClient.signMessage({ account, message: m }) }`
 *  - **ed25519 (NEAR/Solana keys)**: supply the 32-byte seed; we sign NEP-413.
 *
 * `localEvmWallet` / `localEd25519Wallet` sign locally with a raw key — handy for
 * the demo endpoint, tests, and server-side payers.
 */
import {
  ed25519AccountIdFromSecretKey,
  erc191Digest,
  evmAddressFromSecpPublicKey,
  evmAddressToAccountId,
  toBase58,
  toHex,
} from "@solvador/near-intents-core";
import { secp256k1 } from "@noble/curves/secp256k1";

/** An EVM wallet identified by its address, signing via EIP-191 personal_sign. */
export type EvmWallet = {
  kind: "evm";
  /** Lowercase or checksummed `0x` address. */
  address: string;
  /** Returns a 0x-hex 65-byte signature over the UTF-8 message (personal_sign). */
  signPersonalMessage(message: string): Promise<string> | string;
};

/** An ed25519 wallet (NEAR/Solana key) signing NEP-413 messages. */
export type Ed25519Wallet = {
  kind: "ed25519";
  /** 32-byte ed25519 seed. */
  secretKey: Uint8Array;
  /** signer_id; defaults to the NEAR-implicit account of the key. */
  accountId?: string;
};

export type NearIntentsClientWallet = EvmWallet | Ed25519Wallet;

/** Build an EVM wallet that signs locally with a raw 32-byte secp256k1 key. */
export function localEvmWallet(secpSecretKey: Uint8Array): EvmWallet {
  const address = evmAddressFromSecpPublicKey(secp256k1.getPublicKey(secpSecretKey, false));
  return {
    kind: "evm",
    address,
    signPersonalMessage(message: string): string {
      const sig = secp256k1.sign(erc191Digest(message), secpSecretKey);
      const raw = new Uint8Array(65);
      raw.set(sig.toCompactRawBytes(), 0);
      raw[64] = sig.recovery + 27; // emit Ethereum-style v (27/28); client normalizes
      return `0x${toHex(raw)}`;
    },
  };
}

/** Build an ed25519 wallet from a 32-byte seed (accountId defaults to implicit). */
export function localEd25519Wallet(seed: Uint8Array, accountId?: string): Ed25519Wallet {
  return {
    kind: "ed25519",
    secretKey: seed,
    accountId: accountId ?? ed25519AccountIdFromSecretKey(seed),
  };
}

/** The intents account id (signer_id) a wallet pays from. */
export function walletSignerId(wallet: NearIntentsClientWallet): string {
  if (wallet.kind === "evm") return evmAddressToAccountId(wallet.address);
  return wallet.accountId ?? ed25519AccountIdFromSecretKey(wallet.secretKey);
}

/** Public key string helper (not used internally; exported for convenience). */
export { toBase58 };
