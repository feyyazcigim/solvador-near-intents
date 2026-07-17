/**
 * Minimal EIP-1193 helpers — no wallet SDK. The payer's ONLY cryptographic act
 * is one `eth_signTypedData_v4` (EIP-3009 transferWithAuthorization): the
 * facilitator broadcasts it and pays the gas, so the wallet needs USDC but
 * zero ETH.
 */

type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export const BASE_CHAIN_ID = 8453;
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function getProvider(): Eip1193Provider {
  if (!window.ethereum) {
    throw new Error("No EVM wallet found — install MetaMask (or any injected wallet) and reload.");
  }
  return window.ethereum;
}

export function hasProvider(): boolean {
  return Boolean(window.ethereum);
}

export async function connect(): Promise<string> {
  const accounts = (await getProvider().request({ method: "eth_requestAccounts" })) as string[];
  const account = accounts[0];
  if (!account) throw new Error("Wallet returned no accounts.");
  return account;
}

/** Already-authorized account, if any — silent (`eth_accounts`), no wallet popup. */
export async function connectedAccount(): Promise<string | undefined> {
  if (!window.ethereum) return undefined;
  try {
    const accounts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
    return accounts[0];
  } catch {
    return undefined;
  }
}

export function onAccountsChanged(handler: (accounts: string[]) => void): () => void {
  const provider = window.ethereum;
  provider?.on?.("accountsChanged", handler as (...args: never[]) => void);
  return () => provider?.removeListener?.("accountsChanged", handler as (...args: never[]) => void);
}

export type SignedAuthorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
};

/**
 * Sign (never send) an EIP-3009 `TransferWithAuthorization` for Base USDC:
 * "move `valueAtomic` from me to `to`". Works regardless of the wallet's
 * currently selected chain — the chain id lives in the EIP-712 domain.
 */
export async function signUsdcTransferAuthorization(
  owner: string,
  to: string,
  valueAtomic: bigint,
  validForSeconds = 3600,
): Promise<SignedAuthorization> {
  const nonce = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  const message = {
    from: owner,
    to,
    value: valueAtomic.toString(),
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + validForSeconds),
    nonce,
  };
  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: BASE_CHAIN_ID,
      verifyingContract: BASE_USDC_ADDRESS,
    },
    message,
  };
  const signature = (await getProvider().request({
    method: "eth_signTypedData_v4",
    params: [owner, JSON.stringify(typedData)],
  })) as string;
  return { ...message, signature };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
