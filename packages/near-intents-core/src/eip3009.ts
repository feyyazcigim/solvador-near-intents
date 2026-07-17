/**
 * EIP-3009 `transferWithAuthorization` primitives — the gasless funding leg of
 * `multichain-exact`. The payer signs an EIP-712 authorization ("move X of this
 * token from me to the deposit address"); the facilitator broadcasts it and
 * pays the origin-chain gas. Circle's USDC (FiatTokenV2+) implements it on
 * every chain we care about.
 *
 * No EVM library needed: EIP-712 hashing is keccak over 32-byte words, and
 * recovery reuses the same @noble machinery as our ERC-191 path.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { evmAddressFromSecpPublicKey } from "./accounts.js";
import { fromHex, keccak256, utf8ToBytes } from "./bytes.js";

/** EIP-712 domain of the token contract (e.g. Base USDC: "USD Coin"/"2"). */
export type Eip712Domain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
};

/** A signed `TransferWithAuthorization` message. All uint values decimal strings. */
export type TransferAuthorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  /** 0x-prefixed 32-byte hex (random; single-use per EIP-3009). */
  nonce: string;
  /** 0x-prefixed 65-byte r‖s‖v signature (v 27/28 or 0/1). */
  signature: string;
};

const DOMAIN_TYPEHASH = keccak256(
  utf8ToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
  utf8ToBytes(
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ),
);

/** keccak256(0x1901 ‖ domainSeparator ‖ structHash) — the digest the wallet signs. */
export function transferAuthorizationDigest(
  domain: Eip712Domain,
  auth: Omit<TransferAuthorization, "signature">,
): Uint8Array {
  const domainSeparator = keccak256(
    concat(
      DOMAIN_TYPEHASH,
      keccak256(utf8ToBytes(domain.name)),
      keccak256(utf8ToBytes(domain.version)),
      uint256(BigInt(domain.chainId)),
      address(domain.verifyingContract),
    ),
  );
  const structHash = keccak256(
    concat(
      TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
      address(auth.from),
      address(auth.to),
      uint256(BigInt(auth.value)),
      uint256(BigInt(auth.validAfter)),
      uint256(BigInt(auth.validBefore)),
      bytes32(auth.nonce),
    ),
  );
  return keccak256(concat(new Uint8Array([0x19, 0x01]), domainSeparator, structHash));
}

/** Recover the signer address (lowercase 0x) of a transfer authorization. */
export function recoverTransferAuthorizationSigner(
  domain: Eip712Domain,
  auth: TransferAuthorization,
): string {
  const raw = fromHex(auth.signature.replace(/^0x/, ""));
  if (raw.length !== 65) throw new Error(`signature must be 65 bytes, got ${raw.length}`);
  const last = raw[64]!;
  const recovery = last >= 27 ? last - 27 : last;
  if (recovery !== 0 && recovery !== 1) throw new Error(`bad recovery byte ${last}`);
  const digest = transferAuthorizationDigest(domain, auth);
  const pub = secp256k1.Signature.fromCompact(raw.subarray(0, 64))
    .addRecoveryBit(recovery)
    .recoverPublicKey(digest);
  return evmAddressFromSecpPublicKey(pub.toBytes(false));
}

/** EIP-712 typed-data JSON for `eth_signTypedData_v4` (what the paywall sends). */
export function transferAuthorizationTypedData(
  domain: Eip712Domain,
  auth: Omit<TransferAuthorization, "signature">,
): Record<string, unknown> {
  return {
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
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    message: {
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    },
  };
}

/**
 * Known EIP-712 domains for sponsorable tokens, keyed by `chainId:address`
 * (lowercase). Used to pre-verify signatures before spending relayer gas —
 * unknown tokens skip pre-verification (the tx itself still reverts on a bad
 * signature).
 */
export const KNOWN_EIP3009_DOMAINS: Record<string, Eip712Domain> = {
  // Circle native USDC on Base.
  "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

/**
 * Parse an omft origin asset (`nep141:<chain>-0x<address>.omft.near`) into its
 * EVM chain id + token address. Returns undefined for native/non-EVM assets.
 */
export function parseOmftErc20(originAsset: string): { chainId: number; tokenAddress: string } | undefined {
  const m = /^nep141:([a-z0-9]+)-((0x)[0-9a-f]{40})\.omft\.near$/.exec(originAsset.toLowerCase());
  if (!m) return undefined;
  const chainId = OMFT_CHAIN_IDS[m[1]!];
  return chainId === undefined ? undefined : { chainId, tokenAddress: m[2]! };
}

/** omft chain prefixes → EVM chain ids (extend as 1Click adds chains). */
const OMFT_CHAIN_IDS: Record<string, number> = {
  eth: 1,
  base: 8453,
  arb: 42161,
  op: 10,
};

// ── 32-byte word encoding ─────────────────────────────────────────────────────

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function uint256(v: bigint): Uint8Array {
  if (v < 0n) throw new Error("uint256 must be non-negative");
  return fromHex(v.toString(16).padStart(64, "0"));
}

function address(a: string): Uint8Array {
  const hex = a.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`bad address: ${a}`);
  return fromHex(hex.padStart(64, "0"));
}

function bytes32(v: string): Uint8Array {
  const hex = v.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`bad bytes32: ${v}`);
  return fromHex(hex);
}

