import type { Address, Hex, TypedDataDomain } from "viem";
import { getNetwork } from "./networks.js";

/** EIP-3009 typed data, used by the x402 `exact` scheme to move USDC with a signature. */
export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface TransferWithAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface UsdcDomain extends TypedDataDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export function usdcDomain(chainId: number): UsdcDomain {
  const { usdc } = getNetwork(chainId);
  return {
    name: usdc.eip712.name,
    version: usdc.eip712.version,
    chainId,
    verifyingContract: usdc.address,
  };
}

/** Builds the full payload for `signTypedData` on a USDC transfer authorization. */
export function transferWithAuthorizationTypedData(
  chainId: number,
  message: TransferWithAuthorization,
) {
  return {
    domain: usdcDomain(chainId),
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message,
  } as const;
}
