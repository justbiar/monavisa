import { hashDomain, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  MONAD_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
  autopayPermit,
  networks,
  permit2Domain,
  permitSingleTypedData,
} from "../src/index.js";

// Permit2 DOMAIN_SEPARATOR() read on each network on 2026-10-24.
const ONCHAIN_PERMIT2_DOMAIN_SEPARATOR = {
  [MONAD_CHAIN_ID]: "0x400b2a627bd11055ecf97292e90bbe7028d6624bc17c675cb317ccf231138b5f",
  [MONAD_TESTNET_CHAIN_ID]: "0xa0647e1feb1b2082348038c21a15be6aea95d32da1dea93a14a78edf69f9ea03",
} as const;

describe("permit2", () => {
  it.each([MONAD_CHAIN_ID, MONAD_TESTNET_CHAIN_ID] as const)(
    "reproduces the on-chain Permit2 domain separator on %i",
    (chainId) => {
      const domain = permit2Domain(chainId);
      const separator = hashDomain({
        domain: { ...domain, chainId: BigInt(domain.chainId) },
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
        },
      });
      expect(separator).toBe(ONCHAIN_PERMIT2_DOMAIN_SEPARATOR[chainId]);
    },
  );

  it("sizes the allowance for a number of renewals", () => {
    const permit = autopayPermit({
      token: networks[MONAD_TESTNET_CHAIN_ID].usdc.address,
      spender: "0x000000000000000000000000000000000000dEaD",
      charge: 49_490_000n,
      nonce: 3,
      now: 1_760_000_000,
    });
    expect(permit.details.amount).toBe(49_490_000n * 12n);
    expect(permit.details.nonce).toBe(3);
    expect(permit.details.expiration).toBe(1_760_000_000 + 395 * 86_400);
    expect(permit.sigDeadline).toBe(1_760_000_000n + 1_800n);
  });

  it("produces typed data that signs and recovers", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const typedData = permitSingleTypedData(
      MONAD_TESTNET_CHAIN_ID,
      autopayPermit({
        token: networks[MONAD_TESTNET_CHAIN_ID].usdc.address,
        spender: "0x000000000000000000000000000000000000dEaD",
        charge: 1n,
        nonce: 0,
        now: 1_760_000_000,
      }),
    );
    const signature = await owner.signTypedData(typedData);
    expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(owner.address);
  });
});
