import {
  type Address,
  encodeAbiParameters,
  type Hex,
  keccak256,
  type TypedDataDomain,
  zeroHash,
} from "viem";

export const MONAUTH_DOMAIN_NAME = "Mona Visa MonAuth";
export const MONAUTH_DOMAIN_VERSION = "1";

export function monAuthDomain(chainId: number): TypedDataDomain {
  return {
    name: MONAUTH_DOMAIN_NAME,
    version: MONAUTH_DOMAIN_VERSION,
    chainId,
  };
}

export const mandateTypes = {
  Mandate: [
    { name: "issuer", type: "address" },
    { name: "agent", type: "address" },
    { name: "parent", type: "bytes32" },
    { name: "maxTotal", type: "uint256" },
    { name: "maxPerCall", type: "uint256" },
    { name: "allowedPayees", type: "address[]" },
    { name: "validUntil", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export interface Mandate {
  issuer: Address;
  agent: Address;
  /** Root mandate has parent == bytes32(0) */
  parent: Hex;
  /** Maximum total expenditure allowed under this mandate (base units). */
  maxTotal: bigint;
  /** Maximum per-call expenditure (base units). */
  maxPerCall: bigint;
  /** Allowed payees. Empty array means any payee (only permitted if parent also allowed any). */
  allowedPayees: Address[];
  /** Unix timestamp in seconds. */
  validUntil: bigint;
  nonce: bigint;
}

export interface SignedMandate {
  mandate: Mandate;
  signature: Hex;
}

export function mandateTypedData(chainId: number, mandate: Mandate) {
  return {
    domain: monAuthDomain(chainId),
    types: mandateTypes,
    primaryType: "Mandate",
    message: mandate,
  } as const;
}

export function mandateHash(mandate: Mandate): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address[]" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        mandate.issuer,
        mandate.agent,
        mandate.parent,
        mandate.maxTotal,
        mandate.maxPerCall,
        mandate.allowedPayees,
        mandate.validUntil,
        mandate.nonce,
      ],
    ),
  );
}

export const ROOT_PARENT: Hex = zeroHash;
