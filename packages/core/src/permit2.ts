import type { Address, TypedDataDomain } from "viem";
import { getNetwork } from "./networks.js";

/** Permit2 AllowanceTransfer typed data. One signature gives the AutopayModule a capped, expiring allowance. */
export const permitSingleTypes = {
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
  PermitSingle: [
    { name: "details", type: "PermitDetails" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
} as const;

export interface PermitSingle {
  details: {
    token: Address;
    amount: bigint;
    expiration: number;
    nonce: number;
  };
  spender: Address;
  sigDeadline: bigint;
}

export interface Permit2Domain extends TypedDataDomain {
  name: "Permit2";
  chainId: number;
  verifyingContract: Address;
}

export const permit2Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

/** Permit2 has no version field in its EIP-712 domain. */
export function permit2Domain(chainId: number): Permit2Domain {
  return { name: "Permit2", chainId, verifyingContract: getNetwork(chainId).permit2 };
}

/** Builds the payload for `signTypedData`, ready to pass to AutopayModule.subscribeWithPermit. */
export function permitSingleTypedData(chainId: number, permit: PermitSingle) {
  return {
    domain: permit2Domain(chainId),
    types: permitSingleTypes,
    primaryType: "PermitSingle",
    message: permit,
  } as const;
}

export interface AutopayPermitInput {
  token: Address;
  spender: Address;
  /** Per-renewal charge (price + fee). */
  charge: bigint;
  /** How many charges the allowance should cover. Default 12. */
  periods?: number;
  /** Current Permit2 nonce for (owner, token, spender). */
  nonce: number;
  /** Unix seconds. */
  now: number;
  /** Allowance lifetime in seconds. Default 1 year plus a month of slack. */
  lifetimeSec?: number;
}

/**
 * A capped allowance sized for a number of renewals. The subscriber can see exactly how much
 * can ever be pulled, and revoke it in Permit2 at any time.
 */
export function autopayPermit(input: AutopayPermitInput): PermitSingle {
  const periods = BigInt(input.periods ?? 12);
  const lifetime = input.lifetimeSec ?? 395 * 24 * 60 * 60;
  return {
    details: {
      token: input.token,
      amount: input.charge * periods,
      expiration: input.now + lifetime,
      nonce: input.nonce,
    },
    spender: input.spender,
    sigDeadline: BigInt(input.now + 30 * 60),
  };
}
