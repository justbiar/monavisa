import {
  computeCommitment,
  confirmTypedData,
  reserveTypedData,
  sessionVaultAbi,
} from "@monavisa/core";
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  toHex,
  type Transport,
  type WalletClient,
} from "viem";

export interface EscrowClientOptions {
  chainId: number;
  sessionVault: Address;
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
}

export interface EscrowState {
  sessionId: Hex;
  provider: Address;
  amount: bigint;
  deadline: number;
  status: number;
  commitment: Hex;
}

export class EscrowClient {
  readonly chainId: number;
  readonly sessionVault: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient<Transport, Chain, Account>;

  constructor(options: EscrowClientOptions) {
    this.chainId = options.chainId;
    this.sessionVault = options.sessionVault;
    this.publicClient = options.publicClient;
    this.walletClient = options.walletClient;
  }

  /**
   * Reserves an amount from an open session for an escrow.
   */
  async reserve(params: {
    sessionId: Hex;
    provider: Address;
    amount: bigint;
    deadlineSec: number;
    nonce?: Hex;
  }): Promise<{ escrowId: Hex; hash: Hex }> {
    const nonce = params.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(32)));
    const account = this.walletClient.account;

    const call = {
      address: this.sessionVault,
      abi: sessionVaultAbi,
      functionName: "reserve",
      args: [params.sessionId, params.provider, params.amount, params.deadlineSec, nonce, "0x"],
      account,
    } as const;

    const est = await this.publicClient.estimateContractGas(call);
    const hash = await this.walletClient.writeContract({
      ...call,
      chain: this.walletClient.chain,
      gas: est + est / 10n,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    const log = receipt.logs.find(
      (l) => l.address.toLowerCase() === this.sessionVault.toLowerCase(),
    );
    const escrowId = (log?.topics[1] as Hex) ?? "0x";
    return { escrowId, hash };
  }

  /**
   * Provider commits delivery payload hash C = SHA-256(canonical(data)).
   */
  async commit(escrowId: Hex, data: unknown): Promise<{ commitment: Hex; hash: Hex }> {
    const commitment = computeCommitment(data);
    const call = {
      address: this.sessionVault,
      abi: sessionVaultAbi,
      functionName: "commit",
      args: [escrowId, commitment],
      account: this.walletClient.account,
    } as const;

    const est = await this.publicClient.estimateContractGas(call);
    const hash = await this.walletClient.writeContract({
      ...call,
      chain: this.walletClient.chain,
      gas: est + est / 10n,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { commitment, hash };
  }

  /**
   * Checks whether the committed hash matches the payload data.
   */
  async verify(escrowId: Hex, data: unknown): Promise<boolean> {
    const state = await this.getEscrow(escrowId);
    const expected = computeCommitment(data);
    return state.commitment.toLowerCase() === expected.toLowerCase();
  }

  /**
   * Confirms delivery and settles payment to provider.
   */
  async confirm(escrowId: Hex): Promise<Hex> {
    const call = {
      address: this.sessionVault,
      abi: sessionVaultAbi,
      functionName: "confirm",
      args: [escrowId, "0x"],
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

  /**
   * Refunds reserved funds back to session if deadline has passed.
   */
  async refund(escrowId: Hex): Promise<Hex> {
    const call = {
      address: this.sessionVault,
      abi: sessionVaultAbi,
      functionName: "refund",
      args: [escrowId],
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

  async getEscrow(escrowId: Hex): Promise<EscrowState> {
    const data = await this.publicClient.readContract({
      address: this.sessionVault,
      abi: sessionVaultAbi,
      functionName: "getEscrow",
      args: [escrowId],
    });
    return {
      sessionId: data.sessionId,
      provider: data.provider,
      amount: BigInt(data.amount),
      deadline: Number(data.deadline),
      status: Number(data.status),
      commitment: data.commitment,
    };
  }
}
