import {
  getNetwork,
  type SessionState,
  sessionVaultAbi,
} from "@monavisa/core";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  type Hex,
  http,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

export interface SessionClientOptions {
  chainId: number;
  sessionVault: Address;
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
}

export class SessionClient {
  readonly chainId: number;
  readonly sessionVault: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient<Transport, Chain, Account>;

  constructor(options: SessionClientOptions) {
    this.chainId = options.chainId;
    this.sessionVault = options.sessionVault;
    this.publicClient = options.publicClient;
    this.walletClient = options.walletClient;
  }

  /**
   * Approves SessionVault and opens a new prepaid session.
   */
  async openSession(params: {
    signer: Address;
    amount: bigint;
    durationSec: number;
    token?: Address;
  }): Promise<{ sessionId: Hex; hash: Hex }> {
    const token = params.token ?? getNetwork(this.chainId).usdc.address;
    const account = this.walletClient.account;

    // Approve token first
    const approveCall = {
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.sessionVault, params.amount],
      account,
    } as const;
    const approveEstimate = await this.publicClient.estimateContractGas(approveCall);
    const approveTx = await this.walletClient.writeContract({
      ...approveCall,
      chain: this.walletClient.chain,
      gas: approveEstimate + approveEstimate / 10n,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: approveTx });

    // Open session
    const head = await this.publicClient.getBlock();
    const expiresAt = Number(head.timestamp) + params.durationSec;

    const openCall = {
      address: this.sessionVault,
      abi: sessionVaultAbi,
      functionName: "openSession",
      args: [params.signer, token, params.amount, expiresAt],
      account,
    } as const;
    const openEstimate = await this.publicClient.estimateContractGas(openCall);
    const hash = await this.walletClient.writeContract({
      ...openCall,
      chain: this.walletClient.chain,
      gas: openEstimate + openEstimate / 10n,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    // Find SessionOpened event to extract sessionId
    const log = receipt.logs.find(
      (l) => l.address.toLowerCase() === this.sessionVault.toLowerCase(),
    );
    const sessionId = (log?.topics[1] as Hex) ?? "0x";

    return { sessionId, hash };
  }

  async topUp(sessionId: Hex, amount: bigint, token?: Address): Promise<Hex> {
    const account = this.walletClient.account;
    const sess = await this.getSession(sessionId);
    const tokenAddr = token ?? sess.token;

    // Approve
    const approveCall = {
      address: tokenAddr,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.sessionVault, amount],
      account,
    } as const;
    const approveEstimate = await this.publicClient.estimateContractGas(approveCall);
    const approveTx = await this.walletClient.writeContract({
      ...approveCall,
      chain: this.walletClient.chain,
      gas: approveEstimate + approveEstimate / 10n,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: approveTx });

    const call = {
      address: this.sessionVault,
      abi: sessionVaultAbi,
      functionName: "topUp",
      args: [sessionId, amount],
      account,
    } as const;
    const est = await this.publicClient.estimateContractGas(call);
    const hash = await this.walletClient.writeContract({
      ...call,
      chain: this.walletClient.chain,
      gas: est + est / 10n,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async extendSession(sessionId: Hex, expiresAt: number): Promise<Hex> {
    const call = {
      address: this.sessionVault,
      abi: sessionVaultAbi,
      functionName: "extendSession",
      args: [sessionId, expiresAt],
      account: this.walletClient.account,
    } as const;
    const est = await this.publicClient.estimateContractGas(call);
    const hash = await this.walletClient.writeContract({
      ...call,
      chain: this.walletClient.chain,
      gas: est + est / 10n,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async requestClose(sessionId: Hex): Promise<Hex> {
    const call = {
      address: this.sessionVault,
      abi: sessionVaultAbi,
      functionName: "requestClose",
      args: [sessionId],
      account: this.walletClient.account,
    } as const;
    const est = await this.publicClient.estimateContractGas(call);
    const hash = await this.walletClient.writeContract({
      ...call,
      chain: this.walletClient.chain,
      gas: est + est / 10n,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async withdraw(sessionId: Hex): Promise<Hex> {
    const call = {
      address: this.sessionVault,
      abi: sessionVaultAbi,
      functionName: "withdraw",
      args: [sessionId],
      account: this.walletClient.account,
    } as const;
    const est = await this.publicClient.estimateContractGas(call);
    const hash = await this.walletClient.writeContract({
      ...call,
      chain: this.walletClient.chain,
      gas: est + est / 10n,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async getSession(sessionId: Hex): Promise<SessionState> {
    const data = await this.publicClient.readContract({
      address: this.sessionVault,
      abi: sessionVaultAbi,
      functionName: "getSession",
      args: [sessionId],
    });
    return {
      owner: data.owner,
      balance: BigInt(data.balance),
      signer: data.signer,
      expiresAt: Number(data.expiresAt),
      closesAt: Number(data.closesAt),
      token: data.token,
    };
  }
}
