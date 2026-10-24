import {
  autopayModuleAbi,
  autopayPermit,
  permit2Abi,
  permitSingleTypedData,
  planFactoryAbi,
  subscriptionRegistryAbi,
  subscriptionStatusName,
  type SubscriptionStatusName,
} from "@monavisa/core";
import { useCallback, useState } from "react";
import { type Address, erc20Abi, type Hash, parseEventLogs } from "viem";
import { useConfig, useConnection, useReadContract, useReadContracts } from "wagmi";
import {
  getBytecode,
  readContract,
  signTypedData,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import { useMonaVisa } from "./context.js";
import { type CheckoutStep, checkoutSteps } from "./format.js";

export interface Plan {
  id: bigint;
  merchant: Address;
  token: Address;
  price: bigint;
  /** Seconds. */
  period: number;
  trialPeriod: number;
  gracePeriod: number;
  treasury: Address;
  active: boolean;
  /** What each renewal pulls from the subscriber: price plus protocol fee. */
  charge: bigint;
  tokenSymbol: string;
  tokenDecimals: number;
}

/** Plan terms plus the exact per-renewal charge and the token's symbol and decimals. */
export interface UsePlanResult {
  plan: Plan | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function usePlan(planId: bigint | undefined): UsePlanResult {
  const { addresses, chainId } = useMonaVisa();
  const base = useReadContracts({
    allowFailure: false,
    contracts: [
      {
        address: addresses.planFactory,
        abi: planFactoryAbi,
        functionName: "getPlan",
        args: [planId ?? 0n],
        chainId,
      },
      {
        address: addresses.autopay,
        abi: autopayModuleAbi,
        functionName: "chargeAmount",
        args: [planId ?? 0n],
        chainId,
      },
    ],
    query: { enabled: planId !== undefined },
  });
  const token = base.data?.[0].token;
  const meta = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: token, abi: erc20Abi, functionName: "symbol", chainId },
      { address: token, abi: erc20Abi, functionName: "decimals", chainId },
    ],
    query: { enabled: token !== undefined },
  });

  const plan: Plan | undefined =
    base.data && meta.data && planId !== undefined
      ? {
          id: planId,
          ...base.data[0],
          charge: base.data[1],
          tokenSymbol: meta.data[0],
          tokenDecimals: meta.data[1],
        }
      : undefined;

  return {
    plan,
    isLoading: base.isLoading || meta.isLoading,
    error: base.error ?? meta.error,
  };
}

export interface SubscriptionView {
  id: bigint;
  planId: bigint;
  pendingPlanId: bigint | null;
  status: SubscriptionStatusName;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  inTrial: boolean;
}

/** The connected wallet's subscription to `planId`, if any, and whether it grants access now. */
export interface UseSubscriptionResult {
  subscription: SubscriptionView | null;
  entitled: boolean;
  isLoading: boolean;
  refetch: () => Promise<void>;
}

export function useSubscription(planId: bigint | undefined): UseSubscriptionResult {
  const { addresses, chainId } = useMonaVisa();
  const { address } = useConnection();
  const enabled = planId !== undefined && address !== undefined;

  const ids = useReadContracts({
    allowFailure: false,
    contracts: [
      {
        address: addresses.registry,
        abi: subscriptionRegistryAbi,
        functionName: "subscriptionOf",
        args: [address ?? "0x0000000000000000000000000000000000000000", planId ?? 0n],
        chainId,
      },
      {
        address: addresses.registry,
        abi: subscriptionRegistryAbi,
        functionName: "isEntitled",
        args: [address ?? "0x0000000000000000000000000000000000000000", planId ?? 0n],
        chainId,
      },
    ],
    query: { enabled },
  });
  const subId = ids.data?.[0];
  const sub = useReadContract({
    address: addresses.registry,
    abi: subscriptionRegistryAbi,
    functionName: "getSubscription",
    args: [subId ?? 0n],
    chainId,
    query: { enabled: subId !== undefined && subId !== 0n },
  });

  const subscription: SubscriptionView | null =
    subId && sub.data
      ? {
          id: subId,
          planId: sub.data.planId,
          pendingPlanId: sub.data.pendingPlanId === 0n ? null : sub.data.pendingPlanId,
          status: subscriptionStatusName(sub.data.status),
          currentPeriodStart: sub.data.currentPeriodStart,
          currentPeriodEnd: sub.data.currentPeriodEnd,
          inTrial: sub.data.inTrial,
        }
      : null;

  const refetch = useCallback(async () => {
    await ids.refetch();
    await sub.refetch();
  }, [ids, sub]);

  return {
    subscription,
    entitled: ids.data?.[1] ?? false,
    isLoading: ids.isLoading || sub.isLoading,
    refetch,
  };
}

/**
 * Client-side gate: true when the connected wallet is entitled under any of `planIds`.
 * For anything that costs money, check on the server with @monavisa/node as well.
 */
export function useEntitlement(planIds: readonly bigint[]): {
  enabled: boolean;
  isLoading: boolean;
} {
  const { addresses, chainId } = useMonaVisa();
  const { address } = useConnection();
  const result = useReadContracts({
    allowFailure: false,
    contracts: planIds.map((planId) => ({
      address: addresses.registry,
      abi: subscriptionRegistryAbi,
      functionName: "isEntitled",
      args: [address ?? "0x0000000000000000000000000000000000000000", planId],
      chainId,
    })),
    query: { enabled: address !== undefined && planIds.length > 0 },
  });
  return {
    enabled: (result.data as boolean[] | undefined)?.some(Boolean) ?? false,
    isLoading: result.isLoading,
  };
}

export type CheckoutState =
  | { status: "idle" }
  | { status: "running"; step: CheckoutStep; steps: CheckoutStep[] }
  | { status: "success"; subscriptionId: bigint; transactionHash: Hash }
  | { status: "error"; error: Error; step: CheckoutStep | null };

export interface CheckoutOptions {
  /** How many renewals the Permit2 allowance covers. Default 12. */
  periods?: number;
}

/**
 * Subscribes the connected wallet to a plan:
 * 1. approve the token to Permit2 (once per token, skipped when already enough),
 * 2. sign a capped Permit2 allowance for the AutopayModule,
 * 3. call subscribeWithPermit, which charges the first period unless the plan has a trial.
 */
export function useCheckout(plan: Plan | undefined, options: CheckoutOptions = {}) {
  const config = useConfig();
  const { addresses, chainId } = useMonaVisa();
  const { address } = useConnection();
  const [state, setState] = useState<CheckoutState>({ status: "idle" });

  const subscribe = useCallback(async () => {
    if (!plan || !address) return;
    let current: CheckoutStep | null = null;
    try {
      const now = Math.floor(Date.now() / 1000);
      const [, , nonce] = await readContract(config, {
        address: addresses.permit2,
        abi: permit2Abi,
        functionName: "allowance",
        args: [address, plan.token, addresses.autopay],
        chainId,
      });
      const permit = autopayPermit({
        token: plan.token,
        spender: addresses.autopay,
        charge: plan.charge,
        nonce,
        now,
        ...(options.periods === undefined ? {} : { periods: options.periods }),
      });
      const tokenAllowance = await readContract(config, {
        address: plan.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, addresses.permit2],
        chainId,
      });
      const code = await getBytecode(config, { address, chainId });
      const steps = checkoutSteps(tokenAllowance, permit.details.amount, !!code && code !== "0x");

      if (steps.includes("approve")) {
        current = "approve";
        setState({ status: "running", step: current, steps });
        const hash = await writeContract(config, {
          address: plan.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [addresses.permit2, permit.details.amount],
          chainId,
        });
        await waitForTransactionReceipt(config, { hash, chainId });
      }

      let hash: Hash;
      if (steps.includes("authorize")) {
        current = "authorize";
        setState({ status: "running", step: current, steps });
        const authorizeHash = await writeContract(config, {
          address: addresses.permit2,
          abi: permit2Abi,
          functionName: "approve",
          args: [plan.token, addresses.autopay, permit.details.amount, permit.details.expiration],
          chainId,
        });
        await waitForTransactionReceipt(config, { hash: authorizeHash, chainId });

        current = "subscribe";
        setState({ status: "running", step: current, steps });
        hash = await writeContract(config, {
          address: addresses.autopay,
          abi: autopayModuleAbi,
          functionName: "subscribe",
          args: [plan.id],
          chainId,
        });
      } else {
        current = "sign";
        setState({ status: "running", step: current, steps });
        const signature = await signTypedData(config, permitSingleTypedData(chainId, permit));

        current = "subscribe";
        setState({ status: "running", step: current, steps });
        hash = await writeContract(config, {
          address: addresses.autopay,
          abi: autopayModuleAbi,
          functionName: "subscribeWithPermit",
          args: [plan.id, permit, signature],
          chainId,
        });
      }
      const receipt = await waitForTransactionReceipt(config, { hash, chainId });
      if (receipt.status !== "success") throw new Error("Subscription transaction reverted");

      const [activated] = parseEventLogs({
        abi: subscriptionRegistryAbi,
        eventName: "SubscriptionActivated",
        logs: receipt.logs,
      });
      if (!activated) throw new Error("Subscription event not found in the receipt");
      setState({ status: "success", subscriptionId: activated.args.subId, transactionHash: hash });
    } catch (err) {
      setState({ status: "error", error: toError(err), step: current });
    }
  }, [plan, address, config, addresses, chainId, options.periods]);

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, subscribe, reset };
}

export type ManageAction = "cancel" | "changePlan" | "cancelPlanChange";

/** Cancel, upgrade/downgrade, or drop a scheduled downgrade for one subscription. */
export function useManageSubscription(subscriptionId: bigint | undefined) {
  const config = useConfig();
  const { addresses, chainId } = useMonaVisa();
  const [pending, setPending] = useState<ManageAction | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (action: ManageAction, send: () => Promise<Hash>) => {
      if (subscriptionId === undefined) return;
      setPending(action);
      setError(null);
      try {
        const hash = await send();
        const receipt = await waitForTransactionReceipt(config, { hash, chainId });
        if (receipt.status !== "success") throw new Error("Transaction reverted");
      } catch (err) {
        setError(toError(err));
      } finally {
        setPending(null);
      }
    },
    [subscriptionId, config, chainId],
  );

  const id = subscriptionId ?? 0n;
  return {
    pending,
    error,
    cancel: () =>
      run("cancel", () =>
        writeContract(config, {
          address: addresses.registry,
          abi: subscriptionRegistryAbi,
          functionName: "cancel",
          args: [id],
          chainId,
        }),
      ),
    changePlan: (toPlanId: bigint) =>
      run("changePlan", () =>
        writeContract(config, {
          address: addresses.autopay,
          abi: autopayModuleAbi,
          functionName: "changePlan",
          args: [id, toPlanId],
          chainId,
        }),
      ),
    cancelPlanChange: () =>
      run("cancelPlanChange", () =>
        writeContract(config, {
          address: addresses.autopay,
          abi: autopayModuleAbi,
          functionName: "cancelPlanChange",
          args: [id],
          chainId,
        }),
      ),
  };
}

function toError(err: unknown): Error {
  if (err instanceof Error) {
    // viem errors carry a readable first line in shortMessage.
    const short = (err as { shortMessage?: string }).shortMessage;
    return short ? Object.assign(new Error(short), { cause: err }) : err;
  }
  return new Error(String(err));
}
