import {
  caip2,
  type ExactPayload,
  exactTypedData,
  parseCaip2,
  type PaymentPayload,
  type PaymentRequirements,
  requirementsMatch,
  type SessionPayload,
  sessionVaultAbi,
  type SettleResponse,
  type SupportedResponse,
  type VerifyRequest,
  type VerifyResponse,
  voucherTypedData,
  X402_VERSION,
} from "@monavisa/core";
import { evaluateSpend } from "@monavisa/core";
import { Hono } from "hono";
import {
  type Account,
  type Address,
  type Chain,
  erc20Abi,
  getAddress,
  type Hex,
  parseAbi,
  type PublicClient,
  recoverTypedDataAddress,
  type Transport,
  type WalletClient,
} from "viem";
import { z } from "zod";
import type { Db } from "./db.js";

const eip3009Abi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);

export interface FacilitatorOptions {
  chainId: number;
  sessionVault: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient<Transport, Chain, Account>;
  now?: () => number;
}

export function createFacilitatorRouter(db: Db, options: FacilitatorOptions) {
  const router = new Hono();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const chainId = options.chainId;
  const network = caip2(chainId);

  router.get("/supported", (c) => {
    const res: SupportedResponse = {
      kinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network,
        },
        {
          x402Version: X402_VERSION,
          scheme: "session",
          network,
          extra: { sessionVault: options.sessionVault },
        },
      ],
      extensions: [],
      signers: options.walletClient?.account?.address
        ? { [network]: [options.walletClient.account.address] }
        : {},
    };
    return c.json(res);
  });

  router.post("/verify", async (c) => {
    const body = (await c.req.json().catch(() => null)) as VerifyRequest | null;
    if (!body?.paymentPayload || !body?.paymentRequirements) {
      return c.json({ isValid: false, invalidReason: "Missing paymentPayload or paymentRequirements" }, 400);
    }
    const result = await verifyPayment(db, options, body.paymentPayload, body.paymentRequirements, now());
    return c.json(result);
  });

  router.post("/settle", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      paymentPayload?: PaymentPayload;
      paymentRequirements?: PaymentRequirements;
    } | null;
    if (!body?.paymentPayload || !body?.paymentRequirements) {
      return c.json({ success: false, errorReason: "Missing paymentPayload or paymentRequirements" }, 400);
    }
    const result = await settlePayment(db, options, body.paymentPayload, body.paymentRequirements, now());
    return c.json(result, result.success ? 200 : 402);
  });

  return router;
}

export async function verifyPayment(
  db: Db,
  options: FacilitatorOptions,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  nowSec: number,
): Promise<VerifyResponse> {
  if (payload.x402Version !== X402_VERSION) {
    return { isValid: false, invalidReason: `Unsupported x402Version ${payload.x402Version}` };
  }
  if (!requirementsMatch(payload.accepted, requirements)) {
    return { isValid: false, invalidReason: "Accepted requirements do not match server requirements" };
  }
  if (payload.accepted.network !== caip2(options.chainId)) {
    return { isValid: false, invalidReason: `Network mismatch: expected ${caip2(options.chainId)}` };
  }

  if (payload.accepted.scheme === "exact") {
    const exact = payload.payload as ExactPayload;
    if (!exact?.authorization || !exact?.signature) {
      return { isValid: false, invalidReason: "Missing exact authorization or signature" };
    }
    const auth = exact.authorization;
    if (getAddress(auth.to) !== getAddress(requirements.payTo)) {
      return { isValid: false, invalidReason: "Authorization payee does not match payTo" };
    }
    if (BigInt(auth.value) < BigInt(requirements.amount)) {
      return { isValid: false, invalidReason: "Authorization amount less than required" };
    }
    if (BigInt(nowSec) <= BigInt(auth.validAfter)) {
      return { isValid: false, invalidReason: "Authorization not yet valid" };
    }
    if (BigInt(nowSec) >= BigInt(auth.validBefore)) {
      return { isValid: false, invalidReason: "Authorization expired" };
    }

    try {
      const recovered = await recoverTypedDataAddress({
        ...exactTypedData(requirements, {
          from: auth.from,
          to: auth.to,
          value: BigInt(auth.value),
          validAfter: BigInt(auth.validAfter),
          validBefore: BigInt(auth.validBefore),
          nonce: auth.nonce,
        }),
        signature: exact.signature,
      });
      if (getAddress(recovered) !== getAddress(auth.from)) {
        return { isValid: false, invalidReason: "Invalid signature for authorization" };
      }
    } catch (err) {
      return { isValid: false, invalidReason: `Signature verification failed: ${String(err)}` };
    }

    // Check balance
    try {
      const balance = await options.publicClient.readContract({
        address: requirements.asset,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [auth.from],
      });
      if (balance < BigInt(requirements.amount)) {
        return { isValid: false, invalidReason: "Insufficient token balance" };
      }
    } catch (err) {
      return { isValid: false, invalidReason: `Balance check failed: ${String(err)}` };
    }

    return { isValid: true, payer: auth.from };
  }

  if (payload.accepted.scheme === "session") {
    const sess = payload.payload as SessionPayload;
    if (!sess?.sessionId || !sess?.cumulativeAmount || !sess?.signature) {
      return { isValid: false, invalidReason: "Missing session payload fields" };
    }

    // Fetch session state from DB or chain
    const [row] = await db.query<{
      owner: string;
      signer: string;
      token: string;
      balance: string;
      expires_at: string;
      closes_at: string;
    }>(
      "select owner, signer, token, balance, expires_at, closes_at from vault_sessions where session_id = $1",
      [sess.sessionId],
    );

    let sessionOwner: Address;
    let sessionSigner: Address;
    let sessionToken: Address;
    let sessionBalance: bigint;
    let sessionExpiresAt: number;
    let sessionClosesAt: number;

    if (row) {
      sessionOwner = getAddress(row.owner);
      sessionSigner = getAddress(row.signer);
      sessionToken = getAddress(row.token);
      sessionBalance = BigInt(row.balance);
      sessionExpiresAt = Number(row.expires_at);
      sessionClosesAt = Number(row.closes_at);
    } else {
      // Read directly from contract if not yet indexed
      try {
        const onChain = await options.publicClient.readContract({
          address: options.sessionVault,
          abi: sessionVaultAbi,
          functionName: "getSession",
          args: [sess.sessionId],
        });
        if (onChain.owner === "0x0000000000000000000000000000000000000000") {
          return { isValid: false, invalidReason: "Session not found" };
        }
        sessionOwner = onChain.owner;
        sessionSigner = onChain.signer;
        sessionToken = onChain.token;
        sessionBalance = BigInt(onChain.balance);
        sessionExpiresAt = Number(onChain.expiresAt);
        sessionClosesAt = Number(onChain.closesAt);
      } catch (err) {
        return { isValid: false, invalidReason: `Session lookup failed: ${String(err)}` };
      }
    }

    if (getAddress(sessionToken) !== getAddress(requirements.asset)) {
      return { isValid: false, invalidReason: "Session token does not match payment asset" };
    }
    if (sessionClosesAt !== 0 && nowSec >= sessionClosesAt) {
      return { isValid: false, invalidReason: "Session closed" };
    }
    if (nowSec >= sessionExpiresAt) {
      return { isValid: false, invalidReason: "Session expired" };
    }

    // Check voucher signature
    const voucherMessage = {
      sessionId: sess.sessionId,
      payee: requirements.payTo,
      cumulativeAmount: BigInt(sess.cumulativeAmount),
    };
    try {
      const recovered = await recoverTypedDataAddress({
        ...voucherTypedData(options.chainId, options.sessionVault, voucherMessage),
        signature: sess.signature,
      });
      if (getAddress(recovered) !== getAddress(sessionSigner)) {
        return { isValid: false, invalidReason: "Voucher signature does not match session signer" };
      }
    } catch (err) {
      return { isValid: false, invalidReason: `Voucher signature error: ${String(err)}` };
    }

    // Look up previous voucher redeemed or cumulative amount
    const [prevVoucher] = await db.query<{ cumulative_amount: string; redeemed_amount: string }>(
      "select cumulative_amount, redeemed_amount from vouchers where session_id = $1 and payee = $2",
      [sess.sessionId, requirements.payTo.toLowerCase()],
    );
    const prevCumulative = prevVoucher ? BigInt(prevVoucher.cumulative_amount) : 0n;
    const newCumulative = BigInt(sess.cumulativeAmount);
    const delta = newCumulative - prevCumulative;

    if (delta < BigInt(requirements.amount)) {
      return { isValid: false, invalidReason: `Voucher delta (${delta}) is less than required amount (${requirements.amount})` };
    }
    if (delta > sessionBalance) {
      return { isValid: false, invalidReason: `Insufficient session balance: needed ${delta}, available ${sessionBalance}` };
    }

    // Evaluate mandates if provided
    if (sess.mandates && sess.mandates.length > 0) {
      const mandateChain = sess.mandates.map((m) => ({
        mandate: {
          issuer: m.mandate.issuer,
          agent: m.mandate.agent,
          parent: m.mandate.parent,
          maxTotal: BigInt(m.mandate.maxTotal),
          maxPerCall: BigInt(m.mandate.maxPerCall),
          allowedPayees: m.mandate.allowedPayees,
          validUntil: BigInt(m.mandate.validUntil),
          nonce: BigInt(m.mandate.nonce),
        },
        signature: m.signature,
      }));

      const spendResult = await evaluateSpend({
        chainId: options.chainId,
        mandateChain,
        payee: requirements.payTo,
        amount: delta,
        totalSpentSoFar: prevCumulative,
        nowSec,
        isRevoked: async (issuer, hash) => {
          const [rev] = await db.query(
            "select 1 from revoked_mandates where issuer = $1 and mandate_hash = $2",
            [issuer.toLowerCase(), hash],
          );
          return !!rev;
        },
      });

      if (!spendResult.allowed) {
        return { isValid: false, invalidReason: `Mandate policy violated: ${spendResult.reason} (${spendResult.details})` };
      }
    }

    return { isValid: true, payer: sessionOwner };
  }

  return { isValid: false, invalidReason: `Unsupported scheme ${payload.accepted.scheme}` };
}

export async function settlePayment(
  db: Db,
  options: FacilitatorOptions,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  nowSec: number,
): Promise<SettleResponse> {
  const verification = await verifyPayment(db, options, payload, requirements, nowSec);
  if (!verification.isValid) {
    return {
      success: false,
      errorReason: verification.invalidReason ?? "Verification failed",
      transaction: "",
      network: requirements.network,
    };
  }

  if (payload.accepted.scheme === "exact") {
    if (!options.walletClient) {
      return {
        success: false,
        errorReason: "Facilitator wallet not configured to submit exact settlement",
        transaction: "",
        network: requirements.network,
      };
    }
    const exact = payload.payload as ExactPayload;
    const auth = exact.authorization;

    try {
      const call = {
        address: requirements.asset,
        abi: eip3009Abi,
        functionName: "transferWithAuthorization",
        args: [
          auth.from,
          auth.to,
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce,
          exact.signature,
        ],
        account: options.walletClient.account,
      } as const;

      const estimate = await options.publicClient.estimateContractGas(call);
      const hash = await options.walletClient.writeContract({
        ...call,
        chain: options.walletClient.chain,
        gas: estimate + estimate / 10n,
      });
      await options.publicClient.waitForTransactionReceipt({ hash });

      const paymentId = `pay_${hash.slice(2, 18)}`;
      await db.query(
        `insert into x402_payments (id, scheme, payer, payee, token, amount, tx_hash, created_at)
         values ($1, 'exact', $2, $3, $4, $5, $6, $7)`,
        [paymentId, auth.from.toLowerCase(), auth.to.toLowerCase(), requirements.asset.toLowerCase(), auth.value, hash, nowSec],
      );

      return {
        success: true,
        transaction: hash,
        network: requirements.network,
        payer: auth.from,
      };
    } catch (err) {
      return {
        success: false,
        errorReason: `On-chain transferWithAuthorization failed: ${String(err)}`,
        transaction: "",
        network: requirements.network,
      };
    }
  }

  if (payload.accepted.scheme === "session") {
    const sess = payload.payload as SessionPayload;
    const paymentId = `pay_${sess.sessionId.slice(2, 10)}_${Date.now()}`;

    await db.query(
      `insert into vouchers (session_id, payee, cumulative_amount, signature, updated_at)
       values ($1, $2, $3, $4, $5)
       on conflict (session_id, payee) do update set
         cumulative_amount = excluded.cumulative_amount,
         signature = excluded.signature,
         updated_at = excluded.updated_at`,
      [sess.sessionId, requirements.payTo.toLowerCase(), sess.cumulativeAmount, sess.signature, nowSec],
    );

    await db.query(
      `insert into x402_payments (id, scheme, payer, payee, token, amount, tx_hash, created_at)
       values ($1, 'session', $2, $3, $4, $5, null, $6)`,
      [paymentId, verification.payer!.toLowerCase(), requirements.payTo.toLowerCase(), requirements.asset.toLowerCase(), requirements.amount, nowSec],
    );

    return {
      success: true,
      transaction: "",
      network: requirements.network,
      ...(verification.payer ? { payer: verification.payer } : {}),
    };
  }

  return {
    success: false,
    errorReason: "Unsupported scheme",
    transaction: "",
    network: requirements.network,
  };
}
