import type { Abi, Address, TransactionReceipt } from "viem";
import type { Config } from "wagmi";
import {
  getConnection,
  getPublicClient,
  switchChain,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/**
 * Sends a contract call from the connected wallet. Gas and fees are estimated on the dashboard's
 * own RPC and passed in, so the wallet only signs and broadcasts: wallets often have a stale or
 * failing RPC configured for Monad Testnet and then fail with "An unknown RPC error occurred".
 * The estimate also surfaces real revert reasons before the wallet opens.
 */
export async function sendContractTx(
  config: Config,
  chainId: number,
  call: ContractCall,
  /** Called once the wallet has broadcast the transaction, before it is mined. */
  onSent?: (hash: `0x${string}`) => void,
): Promise<TransactionReceipt> {
  const connection = getConnection(config);
  if (!connection.address) throw new Error("Cüzdan bağlı değil");
  if (connection.chainId !== chainId) await switchChain(config, { chainId });

  const client = getPublicClient(config, { chainId });
  if (!client) throw new Error(`Ağ ${chainId} yapılandırılmamış`);
  const [gas, fees] = await Promise.all([
    client.estimateContractGas({ ...call, account: connection.address } as never),
    client.estimateFeesPerGas(),
  ]);

  const hash = await writeContract(config, {
    ...call,
    chainId,
    // Monad bills the gas limit, not gas used, so keep the margin small.
    gas: gas + gas / 10n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  } as never);
  onSent?.(hash);
  const receipt = await waitForTransactionReceipt(config, { hash, chainId });
  if (receipt.status !== "success") throw new Error(`İşlem zincirde geri alındı (${hash})`);
  return receipt;
}

/** A readable message for wallet, RPC and API errors, with the detail viem keeps out of shortMessage. */
export function errorText(err: unknown): string {
  const e = err as { name?: string; shortMessage?: string; message?: string; details?: string };
  if (e.name === "UserRejectedRequestError") return "İşlemi cüzdanda reddettin.";
  const message = e.shortMessage ?? e.message ?? String(err);
  const parts = [message];
  if (e.details && !message.includes(e.details)) parts.push(e.details);
  if (e.name === "UnknownRpcError" || /unknown RPC error/i.test(message)) {
    parts.push(
      "Cüzdanın Monad Testnet RPC'si yanıt vermiyor olabilir. Cüzdanın ağ ayarlarında RPC adresini https://testnet-rpc.monad.xyz yapıp tekrar dene.",
    );
  }
  return parts.join(" · ");
}
