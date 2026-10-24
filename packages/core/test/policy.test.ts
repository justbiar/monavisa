import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  computeCommitment,
  deriveChildMandate,
  evaluateSpend,
  type Mandate,
  mandateHash,
  mandateTypedData,
  ROOT_PARENT,
  type SignedMandate,
  validateMandateNarrowing,
} from "../src/index.js";

const rootAccount = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const agentAccount = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const subAgentAccount = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);

const chainId = 10143;

describe("canonicalizeJson and computeCommitment", () => {
  it("sorts keys deterministically", () => {
    const a = { b: 1, a: 2, c: { y: "hello", x: "world" } };
    const b = { c: { x: "world", y: "hello" }, a: 2, b: 1 };
    expect(canonicalizeJson(a)).toBe(canonicalizeJson(b));
    expect(canonicalizeJson(a)).toBe('{"a":2,"b":1,"c":{"x":"world","y":"hello"}}');
    expect(computeCommitment(a)).toBe(computeCommitment(b));
  });
});

describe("MonAuth Mandates and Policy Engine", () => {
  const rootMandate: Mandate = {
    issuer: rootAccount.address,
    agent: agentAccount.address,
    parent: ROOT_PARENT,
    maxTotal: 100_000_000n, // 100 USDC
    maxPerCall: 10_000_000n, // 10 USDC
    allowedPayees: [],
    validUntil: 2_000_000_000n,
    nonce: 1n,
  };

  async function sign(account: typeof rootAccount, mandate: Mandate): Promise<SignedMandate> {
    const signature = await account.signTypedData(mandateTypedData(chainId, mandate));
    return { mandate, signature };
  }

  it("validates narrowing rules correctly", () => {
    const child = deriveChildMandate(rootMandate, {
      agent: subAgentAccount.address,
      maxTotal: 50_000_000n,
      maxPerCall: 5_000_000n,
      nonce: 1n,
    });
    expect(validateMandateNarrowing(rootMandate, child).valid).toBe(true);

    // Cannot widen maxTotal
    expect(() =>
      deriveChildMandate(rootMandate, {
        agent: subAgentAccount.address,
        maxTotal: 200_000_000n,
        nonce: 2n,
      }),
    ).toThrow(/maxTotal/);

    // Cannot widen maxPerCall
    expect(() =>
      deriveChildMandate(rootMandate, {
        agent: subAgentAccount.address,
        maxPerCall: 15_000_000n,
        nonce: 3n,
      }),
    ).toThrow(/maxPerCall/);
  });

  it("evaluates a valid spend request successfully", async () => {
    const signedRoot = await sign(rootAccount, rootMandate);
    const child = deriveChildMandate(rootMandate, {
      agent: subAgentAccount.address,
      maxTotal: 50_000_000n,
      maxPerCall: 5_000_000n,
      nonce: 1n,
    });
    const signedChild = await sign(agentAccount, child);

    const result = await evaluateSpend({
      chainId,
      mandateChain: [signedRoot, signedChild],
      payee: "0x0000000000000000000000000000000000000001",
      amount: 1_000_000n,
      totalSpentSoFar: 0n,
      nowSec: 1_760_000_000,
    });

    expect(result.allowed).toBe(true);
  });

  it("rejects when spend exceeds per-call limit", async () => {
    const signedRoot = await sign(rootAccount, rootMandate);
    const result = await evaluateSpend({
      chainId,
      mandateChain: [signedRoot],
      payee: "0x0000000000000000000000000000000000000001",
      amount: 15_000_000n, // limit is 10
      totalSpentSoFar: 0n,
      nowSec: 1_760_000_000,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("exceeds_per_call_limit");
  });

  it("rejects when mandate is revoked", async () => {
    const signedRoot = await sign(rootAccount, rootMandate);
    const revokedHash = mandateHash(rootMandate);

    const result = await evaluateSpend({
      chainId,
      mandateChain: [signedRoot],
      payee: "0x0000000000000000000000000000000000000001",
      amount: 1_000_000n,
      totalSpentSoFar: 0n,
      nowSec: 1_760_000_000,
      isRevoked: (issuer, hash) => hash === revokedHash,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("revoked");
  });
});
