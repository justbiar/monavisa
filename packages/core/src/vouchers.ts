import { type Address, encodeAbiParameters, type Hex, keccak256, type TypedDataDomain } from "viem";

/** EIP-712 domain of SessionVault (`Mona Visa SessionVault` / `1`). */
export function sessionVaultDomain(chainId: number, sessionVault: Address): TypedDataDomain {
  return { name: "Mona Visa SessionVault", version: "1", chainId, verifyingContract: sessionVault };
}

export const voucherTypes = {
  Voucher: [
    { name: "sessionId", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "cumulativeAmount", type: "uint256" },
  ],
} as const;

/**
 * A session voucher. Cumulative: each new voucher for the same payee replaces the previous one,
 * and redeeming it pays only the difference to what was already redeemed.
 */
export interface Voucher {
  sessionId: Hex;
  payee: Address;
  cumulativeAmount: bigint;
}

export function voucherTypedData(chainId: number, sessionVault: Address, voucher: Voucher) {
  return {
    domain: sessionVaultDomain(chainId, sessionVault),
    types: voucherTypes,
    primaryType: "Voucher",
    message: voucher,
  } as const;
}

/** Session ids are `keccak256(abi.encode(owner, n))` where n is the owner's 1-based session count. */
export function sessionIdFor(owner: Address, index: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, index]));
}

/** On-chain session state as returned by `SessionVault.getSession`. */
export interface SessionState {
  owner: Address;
  balance: bigint;
  signer: Address;
  expiresAt: number;
  closesAt: number;
  token: Address;
}
