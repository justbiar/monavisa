import { type Address, type Hex, sha256, toHex } from "viem";
import { sessionVaultDomain } from "./vouchers.js";

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) serializer.
 * Deterministically sorts object keys and eliminates whitespace.
 */
export function canonicalizeJson(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
  return `{${pairs.join(",")}}`;
}

/**
 * Computes commitment C = SHA-256(canon(D)).
 */
export function computeCommitment(data: unknown): Hex {
  const canon = canonicalizeJson(data);
  const encoder = new TextEncoder();
  return sha256(encoder.encode(canon));
}

export const reserveTypes = {
  Reserve: [
    { name: "sessionId", type: "bytes32" },
    { name: "provider", type: "address" },
    { name: "amount", type: "uint96" },
    { name: "deadline", type: "uint40" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const confirmTypes = {
  Confirm: [{ name: "escrowId", type: "bytes32" }],
} as const;

export function reserveTypedData(
  chainId: number,
  sessionVault: Address,
  message: {
    sessionId: Hex;
    provider: Address;
    amount: bigint;
    deadline: number;
    nonce: Hex;
  },
) {
  return {
    domain: sessionVaultDomain(chainId, sessionVault),
    types: reserveTypes,
    primaryType: "Reserve",
    message,
  } as const;
}

export function confirmTypedData(chainId: number, sessionVault: Address, message: { escrowId: Hex }) {
  return {
    domain: sessionVaultDomain(chainId, sessionVault),
    types: confirmTypes,
    primaryType: "Confirm",
    message,
  } as const;
}
