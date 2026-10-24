import { type Address, getAddress, type Hex, recoverTypedDataAddress, zeroAddress } from "viem";
import {
  type Mandate,
  mandateHash,
  mandateTypedData,
  ROOT_PARENT,
  type SignedMandate,
} from "./mandates.js";

export interface SpendEvaluationRequest {
  chainId: number;
  mandateChain: SignedMandate[];
  payee: Address;
  amount: bigint;
  totalSpentSoFar: bigint;
  nowSec: number;
  isRevoked?: (issuer: Address, hash: Hex) => Promise<boolean> | boolean;
}

export interface SpendEvaluationResult {
  allowed: boolean;
  reason?:
    | "empty_chain"
    | "invalid_root"
    | "invalid_signature"
    | "expired"
    | "revoked"
    | "exceeds_per_call_limit"
    | "exceeds_total_limit"
    | "payee_not_allowed"
    | "invalid_hierarchy";
  details?: string;
}

/**
 * Validates that `child` is a monotonic narrowing of `parent`:
 * - Issuer must match parent's authorized agent
 * - Parent hash must match
 * - Limits must be <= parent
 * - Expiry must be <= parent
 * - Payees must be a subset of parent's allowed payees (if parent restricted them)
 */
export function validateMandateNarrowing(parent: Mandate, child: Mandate): { valid: boolean; reason?: string } {
  if (getAddress(child.issuer) !== getAddress(parent.agent)) {
    return { valid: false, reason: "child issuer must match parent agent" };
  }
  if (child.parent.toLowerCase() !== mandateHash(parent).toLowerCase()) {
    return { valid: false, reason: "child parent hash does not match parent" };
  }
  if (child.maxTotal > parent.maxTotal) {
    return { valid: false, reason: "child maxTotal cannot exceed parent maxTotal" };
  }
  if (child.maxPerCall > parent.maxPerCall) {
    return { valid: false, reason: "child maxPerCall cannot exceed parent maxPerCall" };
  }
  if (child.validUntil > parent.validUntil) {
    return { valid: false, reason: "child validUntil cannot exceed parent validUntil" };
  }

  if (parent.allowedPayees.length > 0) {
    const parentPayees = new Set(parent.allowedPayees.map((a) => getAddress(a)));
    if (child.allowedPayees.length === 0) {
      return { valid: false, reason: "child cannot permit all payees when parent restricted payees" };
    }
    for (const p of child.allowedPayees) {
      if (!parentPayees.has(getAddress(p))) {
        return { valid: false, reason: `payee ${p} not in parent's allowed payees` };
      }
    }
  }

  return { valid: true };
}

/**
 * Derives a child mandate that narrows the parent mandate.
 * Reverts or throws if narrowing rules are violated.
 */
export function deriveChildMandate(
  parent: Mandate,
  overrides: {
    agent: Address;
    maxTotal?: bigint;
    maxPerCall?: bigint;
    allowedPayees?: Address[];
    validUntil?: bigint;
    nonce: bigint;
  },
): Mandate {
  const child: Mandate = {
    issuer: parent.agent,
    agent: overrides.agent,
    parent: mandateHash(parent),
    maxTotal: overrides.maxTotal ?? parent.maxTotal,
    maxPerCall: overrides.maxPerCall ?? parent.maxPerCall,
    allowedPayees: overrides.allowedPayees ?? [...parent.allowedPayees],
    validUntil: overrides.validUntil ?? parent.validUntil,
    nonce: overrides.nonce,
  };

  const validation = validateMandateNarrowing(parent, child);
  if (!validation.valid) {
    throw new Error(`Invalid mandate narrowing: ${validation.reason}`);
  }
  return child;
}

/**
 * Evaluates a spend request against a mandate chain (root first).
 * Deterministic policy: Revoke > Expiry > Deny > Allow.
 */
export async function evaluateSpend(req: SpendEvaluationRequest): Promise<SpendEvaluationResult> {
  const { chainId, mandateChain, payee, amount, totalSpentSoFar, nowSec, isRevoked } = req;
  if (!mandateChain || mandateChain.length === 0) {
    return { allowed: false, reason: "empty_chain", details: "No mandate chain provided" };
  }

  const normalizedPayee = getAddress(payee);

  // Validate chain from root to leaf
  for (let i = 0; i < mandateChain.length; i++) {
    const signed = mandateChain[i]!;
    const mandate = signed.mandate;

    // Root check
    if (i === 0) {
      if (mandate.parent !== ROOT_PARENT) {
        return { allowed: false, reason: "invalid_root", details: "Root mandate parent must be zero" };
      }
    } else {
      const parent = mandateChain[i - 1]!.mandate;
      const narrowing = validateMandateNarrowing(parent, mandate);
      if (!narrowing.valid) {
        return { allowed: false, reason: "invalid_hierarchy", details: narrowing.reason ?? "Invalid hierarchy" };
      }
    }

    // 1. Signature check
    try {
      const recovered = await recoverTypedDataAddress({
        ...mandateTypedData(chainId, mandate),
        signature: signed.signature,
      });
      if (getAddress(recovered) !== getAddress(mandate.issuer)) {
        return { allowed: false, reason: "invalid_signature", details: `Recovered signer ${recovered} does not match issuer ${mandate.issuer}` };
      }
    } catch (err) {
      return { allowed: false, reason: "invalid_signature", details: String(err) };
    }

    // 2. On-chain revocation check
    const mHash = mandateHash(mandate);
    if (isRevoked) {
      const revoked = await isRevoked(mandate.issuer, mHash);
      if (revoked) {
        return { allowed: false, reason: "revoked", details: `Mandate ${mHash} was revoked by ${mandate.issuer}` };
      }
    }

    // 3. Expiry check
    if (BigInt(nowSec) >= mandate.validUntil) {
      return { allowed: false, reason: "expired", details: `Mandate expired at ${mandate.validUntil}` };
    }

    // 4. Per-call limit
    if (amount > mandate.maxPerCall) {
      return { allowed: false, reason: "exceeds_per_call_limit", details: `Amount ${amount} exceeds maxPerCall ${mandate.maxPerCall}` };
    }

    // 5. Total limit
    if (totalSpentSoFar + amount > mandate.maxTotal) {
      return { allowed: false, reason: "exceeds_total_limit", details: `Total spend ${totalSpentSoFar + amount} exceeds maxTotal ${mandate.maxTotal}` };
    }

    // 6. Payee restriction
    if (mandate.allowedPayees.length > 0) {
      const allowedSet = new Set(mandate.allowedPayees.map((a) => getAddress(a)));
      if (!allowedSet.has(normalizedPayee)) {
        return { allowed: false, reason: "payee_not_allowed", details: `Payee ${payee} not in allowed list` };
      }
    }
  }

  return { allowed: true };
}
