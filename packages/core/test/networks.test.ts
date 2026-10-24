import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, hashDomain } from "viem";
import { describe, expect, it } from "vitest";
import {
  MONAD_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
  UnsupportedChainError,
  getChain,
  getContractAddress,
  getNetwork,
  networks,
  usdcDomain,
} from "../src/index.js";

const solidity = readFileSync(
  fileURLToPath(new URL("../../../contracts/src/libraries/MonadAddresses.sol", import.meta.url)),
  "utf8",
);

function solidityConstant(name: string): string {
  const match = solidity.match(new RegExp(`${name}\\s*=\\s*([0-9a-fA-Fx_]+);`));
  if (!match?.[1]) throw new Error(`${name} not found in MonadAddresses.sol`);
  return match[1].replaceAll("_", "");
}

// DOMAIN_SEPARATOR() read from each USDC contract on 2026-10-24.
const ONCHAIN_USDC_DOMAIN_SEPARATOR = {
  [MONAD_CHAIN_ID]: "0xfe22123edc0dd4aeb912eb7948c5f0e531592c2053b3067612f427db342c93c6",
  [MONAD_TESTNET_CHAIN_ID]: "0xf1090f5a61ddee19528cecc447be0f91c7205fc2b34dd271fc0de87809a0a48d",
} as const;

describe("networks", () => {
  it("matches the Solidity MonadAddresses library", () => {
    expect(String(MONAD_CHAIN_ID)).toBe(solidityConstant("MAINNET_CHAIN_ID"));
    expect(String(MONAD_TESTNET_CHAIN_ID)).toBe(solidityConstant("TESTNET_CHAIN_ID"));

    const mainnet = networks[MONAD_CHAIN_ID];
    const testnet = networks[MONAD_TESTNET_CHAIN_ID];
    expect(mainnet.usdc.address).toBe(getAddress(solidityConstant("MAINNET_USDC")));
    expect(testnet.usdc.address).toBe(getAddress(solidityConstant("TESTNET_USDC")));

    for (const network of [mainnet, testnet]) {
      expect(network.permit2).toBe(getAddress(solidityConstant("PERMIT2")));
      expect(network.entryPointV07).toBe(getAddress(solidityConstant("ENTRYPOINT_V07")));
      expect(network.multicall3).toBe(getAddress(solidityConstant("MULTICALL3")));
    }
  });

  it("uses checksummed addresses", () => {
    for (const network of Object.values(networks)) {
      for (const address of [
        network.usdc.address,
        network.permit2,
        network.entryPointV07,
        network.multicall3,
      ]) {
        expect(address).toBe(getAddress(address));
      }
    }
  });

  it("agrees with the chain's multicall3 entry", () => {
    for (const network of Object.values(networks)) {
      expect(getChain(network.chainId).contracts.multicall3.address).toBe(network.multicall3);
    }
  });

  it.each([MONAD_CHAIN_ID, MONAD_TESTNET_CHAIN_ID] as const)(
    "reproduces the on-chain USDC domain separator on %i",
    (chainId) => {
      const domain = usdcDomain(chainId);
      const separator = hashDomain({
        domain: { ...domain, chainId: BigInt(domain.chainId) },
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
        },
      });
      expect(separator).toBe(ONCHAIN_USDC_DOMAIN_SEPARATOR[chainId]);
    },
  );

  it("rejects unsupported chains", () => {
    expect(() => getNetwork(1)).toThrow(UnsupportedChainError);
    expect(() => getChain(1)).toThrow(UnsupportedChainError);
  });

  it("throws for contracts that are not deployed yet", () => {
    expect(() => getContractAddress(MONAD_TESTNET_CHAIN_ID, "planFactory")).toThrow(/not deployed/);
  });
});
