import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  caip2,
  decodeX402Header,
  encodeX402Header,
  exactTypedData,
  parseCaip2,
  type PaymentRequirements,
  requirementsMatch,
  sessionIdFor,
  voucherTypedData,
} from "../src/index.js";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:10143",
  amount: "10000",
  asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  payTo: "0x000000000000000000000000000000000000bEEF",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

describe("x402 headers", () => {
  it("round-trips unicode JSON through base64", () => {
    const value = { resource: { url: "/tıraş", description: "Pro Tıraş ✂️" }, n: 1 };
    const header = encodeX402Header(value);
    expect(header).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(decodeX402Header(header)).toEqual(value);
  });

  it("parses CAIP-2 networks", () => {
    expect(caip2(143)).toBe("eip155:143");
    expect(parseCaip2("eip155:10143")).toBe(10143);
    expect(() => parseCaip2("solana:mainnet")).toThrow();
  });

  it("matches requirements case-insensitively on addresses", () => {
    const other = {
      ...requirements,
      payTo: requirements.payTo.toLowerCase() as `0x${string}`,
      extra: { version: "2", name: "USDC" },
    };
    expect(requirementsMatch(requirements, other)).toBe(true);
    expect(requirementsMatch(requirements, { ...other, amount: "1" })).toBe(false);
    expect(requirementsMatch(requirements, { ...other, scheme: "session" })).toBe(false);
  });
});

describe("typed data", () => {
  it("builds EIP-3009 typed data from the requirements", async () => {
    const message = {
      from: account.address,
      to: requirements.payTo,
      value: 10_000n,
      validAfter: 0n,
      validBefore: 2_000_000_000n,
      nonce: `0x${"11".repeat(32)}` as const,
    };
    const typed = exactTypedData(requirements, message);
    expect(typed.domain).toEqual({
      name: "USDC",
      version: "2",
      chainId: 10143,
      verifyingContract: requirements.asset,
    });
    const signature = await account.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(account.address);
  });

  it("requires the token domain for exact", () => {
    expect(() =>
      exactTypedData({ ...requirements, extra: {} }, {
        from: account.address,
        to: requirements.payTo,
        value: 1n,
        validAfter: 0n,
        validBefore: 1n,
        nonce: `0x${"00".repeat(32)}`,
      }),
    ).toThrow(/extra.name/);
  });

  it("derives session ids like the contract", () => {
    // keccak256(abi.encode(owner, 1)) computed with cast.
    expect(sessionIdFor("0x0000000000000000000000000000000000000001", 1n)).toBe(
      "0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f",
    );
  });

  it("signs vouchers under the SessionVault domain", async () => {
    const vault = "0x00000000000000000000000000000000000000AA";
    const typed = voucherTypedData(10143, vault, {
      sessionId: `0x${"22".repeat(32)}`,
      payee: requirements.payTo,
      cumulativeAmount: 5n,
    });
    expect(typed.domain.name).toBe("Mona Visa SessionVault");
    const signature = await account.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(account.address);
  });
});
