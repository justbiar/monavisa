import type { Address, Hex } from "viem";
import { transferWithAuthorizationTypes } from "./eip3009.js";

/**
 * x402 v2 transport types. Payment data travels in three base64-encoded JSON headers:
 * `PAYMENT-REQUIRED` (server → client, with HTTP 402), `PAYMENT-SIGNATURE` (client → server)
 * and `PAYMENT-RESPONSE` (server → client, with the settled response).
 */
export const X402_VERSION = 2;
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/**
 * Schemes Mona Visa's facilitator settles:
 * - `exact`: one EIP-3009 `transferWithAuthorization` per request, settled on-chain immediately.
 * - `session`: a cumulative SessionVault voucher, accepted at once and redeemed in batches.
 */
export type X402Scheme = "exact" | "session";

export type Caip2Network = `eip155:${number}`;

export const caip2 = (chainId: number): Caip2Network => `eip155:${chainId}`;

export function parseCaip2(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`Unsupported network '${network}'`);
  return Number(match[1]);
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequirements {
  scheme: X402Scheme | (string & {});
  network: Caip2Network | (string & {});
  /** Base units of `asset`. */
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  /**
   * `exact`: `{ name, version }` of the token's EIP-712 domain.
   * `session`: `{ sessionVault }`.
   */
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface ExactAuthorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface ExactPayload {
  signature: Hex;
  authorization: ExactAuthorization;
}

export interface SessionPayload {
  sessionId: Hex;
  /** Total owed to `payTo` by this session so far, including this request. */
  cumulativeAmount: string;
  signature: Hex;
  /** Optional MonAuth mandate chain authorizing the session signer (root first). */
  mandates?: SignedMandateJson[];
}

/** JSON form of a signed mandate (bigints as decimal strings). See `mandates.ts`. */
export interface SignedMandateJson {
  mandate: {
    issuer: Address;
    agent: Address;
    parent: Hex;
    maxTotal: string;
    maxPerCall: string;
    allowedPayees: Address[];
    validUntil: string;
    nonce: string;
  };
  signature: Hex;
}

export interface PaymentPayload<T = ExactPayload | SessionPayload> {
  x402Version: typeof X402_VERSION;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: T;
  extensions?: Record<string, unknown>;
}

export interface VerifyRequest {
  x402Version?: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: Address;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: Address;
  /** Transaction hash for `exact`; empty for `session`, whose vouchers are redeemed in batches. */
  transaction: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
}

// ---------------------------------------------------------------- header encoding

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Base64 of the UTF-8 JSON, as x402 v2 headers expect. */
export function encodeX402Header(value: unknown): string {
  return toBase64(encoder.encode(JSON.stringify(value)));
}

export function decodeX402Header<T>(header: string): T {
  return JSON.parse(decoder.decode(fromBase64(header.trim()))) as T;
}

/** Whether a client's chosen requirements match one the server offered, field by field. */
export function requirementsMatch(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.amount === b.amount &&
    a.asset.toLowerCase() === b.asset.toLowerCase() &&
    a.payTo.toLowerCase() === b.payTo.toLowerCase() &&
    JSON.stringify(sortKeys(a.extra ?? {})) === JSON.stringify(sortKeys(b.extra ?? {}))
  );
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj)
      .map(([k, v]) => [k, typeof v === "string" ? v.toLowerCase() : v] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** EIP-3009 typed data for an `exact` payment, using the asset and domain from the requirements. */
export function exactTypedData(
  requirements: PaymentRequirements,
  authorization: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  },
) {
  const name = requirements.extra?.name;
  const version = requirements.extra?.version;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error("exact requirements need extra.name and extra.version (token EIP-712 domain)");
  }
  return {
    domain: {
      name,
      version,
      chainId: parseCaip2(requirements.network),
      verifyingContract: requirements.asset,
    },
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  } as const;
}
