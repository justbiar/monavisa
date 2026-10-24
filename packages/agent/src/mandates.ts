import {
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import {
  type Mandate,
  type SignedMandate,
  mandateTypedData,
  ROOT_PARENT,
  deriveChildMandate,
  sessionVaultAbi,
} from "@monavisa/core";

export interface CreateRootMandateParams {
  chainId: number;
  signer: {
    address: Address;
    signTypedData: (params: any) => Promise<Hex>;
  };
  agent: Address;
  maxTotal: bigint;
  maxPerCall: bigint;
  allowedPayees?: Address[];
  validUntil: bigint;
  nonce?: bigint;
}

export async function createRootMandate(params: CreateRootMandateParams): Promise<SignedMandate> {
  const mandate: Mandate = {
    issuer: params.signer.address,
    agent: params.agent,
    parent: ROOT_PARENT,
    maxTotal: params.maxTotal,
    maxPerCall: params.maxPerCall,
    allowedPayees: params.allowedPayees ?? [],
    validUntil: params.validUntil,
    nonce: params.nonce ?? BigInt(Date.now()),
  };

  const typedData = mandateTypedData(params.chainId, mandate);
  const signature = await params.signer.signTypedData(typedData);

  return { mandate, signature };
}

export interface CreateChildMandateParams {
  chainId: number;
  signer: {
    address: Address;
    signTypedData: (params: any) => Promise<Hex>;
  };
  parent: Mandate;
  agent: Address;
  maxTotal?: bigint;
  maxPerCall?: bigint;
  allowedPayees?: Address[];
  validUntil?: bigint;
  nonce?: bigint;
}

export async function createChildMandate(params: CreateChildMandateParams): Promise<SignedMandate> {
  const mandate = deriveChildMandate(params.parent, {
    agent: params.agent,
    ...(params.maxTotal !== undefined ? { maxTotal: params.maxTotal } : {}),
    ...(params.maxPerCall !== undefined ? { maxPerCall: params.maxPerCall } : {}),
    ...(params.allowedPayees !== undefined ? { allowedPayees: params.allowedPayees } : {}),
    ...(params.validUntil !== undefined ? { validUntil: params.validUntil } : {}),
    nonce: params.nonce ?? BigInt(Date.now()),
  });

  const typedData = mandateTypedData(params.chainId, mandate);
  const signature = await params.signer.signTypedData(typedData);

  return { mandate, signature };
}

export interface RevokeMandateOnChainParams {
  walletClient: WalletClient;
  sessionVaultAddress: Address;
  mandateHash: Hex;
}

export async function revokeMandateOnChain(
  params: RevokeMandateOnChainParams,
): Promise<Hex> {
  const [account] = await params.walletClient.getAddresses();
  if (!account) throw new Error("Wallet client has no accounts");

  const hash = await params.walletClient.writeContract({
    address: params.sessionVaultAddress,
    abi: sessionVaultAbi,
    functionName: "revokeMandate",
    args: [params.mandateHash],
    account,
    chain: params.walletClient.chain,
  });

  return hash;
}
