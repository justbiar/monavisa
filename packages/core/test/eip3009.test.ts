import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { MONAD_TESTNET_CHAIN_ID, transferWithAuthorizationTypedData } from "../src/index.js";

describe("transferWithAuthorizationTypedData", () => {
  it("produces a payload that signs and recovers to the payer", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const typedData = transferWithAuthorizationTypedData(MONAD_TESTNET_CHAIN_ID, {
      from: payer.address,
      to: "0x000000000000000000000000000000000000dEaD",
      value: 1_000n,
      validAfter: 0n,
      validBefore: 2_000_000_000n,
      nonce: `0x${"11".repeat(32)}`,
    });

    const signature = await payer.signTypedData(typedData);
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature,
    });

    expect(recovered).toBe(payer.address);
    expect(typedData.domain.verifyingContract).toBe("0x534b2f3A21130d7a60830c2Df862319e593943A3");
  });
});
