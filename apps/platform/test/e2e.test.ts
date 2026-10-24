import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  autopayModuleAbi,
  monadTestnet,
  planFactoryAbi,
  subscriptionRegistryAbi,
} from "@monavisa/core";
import { MonaVisaClient, verifyWebhook, type WebhookEvent } from "@monavisa/node";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  erc20Abi,
  http,
  parseAbi,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import type { Db } from "../src/db.js";
import { type IndexerConfig, syncOnce } from "../src/indexer.js";
import { runKeeperOnce } from "../src/keeper.js";
import { createTeam } from "../src/teams.js";
import { deliverDue, fanOutEvents } from "../src/webhooks.js";
import { memoryDb } from "./helpers.js";

/**
 * Full Faz 2 flow on an anvil fork of Monad testnet, using the real Permit2:
 * deploy, create a plan, subscribe, index, check the entitlement through the SDK,
 * let 30 days pass, renew through the keeper, and receive signed webhooks.
 *
 * Runs only when MONAD_TESTNET_RPC_URL is set and anvil/forge are installed.
 */
const RPC = process.env.MONAD_TESTNET_RPC_URL;
const contractsDir = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const PORT = 8600 + Math.floor(Math.random() * 300);
const url = `http://127.0.0.1:${PORT}`;
const PRICE = 49_000_000n;
const DAY = 86_400;

const hasTools = (() => {
  try {
    execFileSync("anvil", ["--version"], { stdio: "ignore" });
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const mockUsdcAbi = parseAbi(["function mint(address to, uint256 amount)"]);

describe.skipIf(!RPC || !hasTools)("end to end on a Monad testnet fork", () => {
  let anvil: ChildProcess;
  let hooks: Server;
  const received: { body: string; signature: string | null }[] = [];
  let db: Db;
  let deployment: Record<string, string | number>;
  let accounts: Address[];

  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(url) });
  const testClient = createTestClient({ chain: monadTestnet, mode: "anvil", transport: http(url) });
  const wallet = (account: Address) =>
    createWalletClient({ chain: monadTestnet, account, transport: http(url) });
  const chainNow = async () => Number((await publicClient.getBlock()).timestamp);

  const indexerConfig = (): IndexerConfig => ({
    chainId: monadTestnet.id,
    planFactory: deployment.planFactory as Address,
    registry: deployment.subscriptionRegistry as Address,
    autopay: deployment.autopayModule as Address,
    startBlock: BigInt(deployment.startBlock!),
    range: 100n,
    blockTag: "latest",
  });
  const indexAll = async () => {
    while (await syncOnce(db, publicClient, indexerConfig()));
  };

  beforeAll(async () => {
    anvil = spawn(
      "anvil",
      ["--fork-url", RPC!, "--port", String(PORT), "--code-size-limit", "131072", "--silent"],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 60; i++) {
      try {
        await publicClient.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    accounts = await createWalletClient({
      chain: monadTestnet,
      transport: http(url),
    }).getAddresses();

    execFileSync(
      "forge",
      [
        "script",
        "script/DeployLocal.s.sol",
        "--rpc-url",
        url,
        "--broadcast",
        "--unlocked",
        "--sender",
        accounts[0]!,
        "--code-size-limit",
        "131072",
      ],
      { cwd: contractsDir, stdio: "ignore" },
    );
    deployment = JSON.parse(readFileSync(`${contractsDir}deployments/local.json`, "utf8"));

    hooks = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ body, signature: req.headers["monavisa-signature"] as string });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => hooks.listen(0, "127.0.0.1", r));
    db = await memoryDb();
  }, 120_000);

  afterAll(async () => {
    anvil?.kill();
    hooks?.close();
    await db?.close();
  });

  it("subscribes, gates a feature, renews through the keeper and sends webhooks", async () => {
    const [, merchant, alice, keeper] = accounts as [Address, Address, Address, Address];
    const usdc = deployment.usdc as Address;
    const autopay = deployment.autopayModule as Address;

    // Merchant creates "Pro Tıraş": 49 USDC / 30 days, 3 days grace.
    const createHash = await wallet(merchant).writeContract({
      address: deployment.planFactory as Address,
      abi: planFactoryAbi,
      functionName: "createPlan",
      args: [usdc, PRICE, 30 * DAY, 0, 3 * DAY, merchant],
    });
    await publicClient.waitForTransactionReceipt({ hash: createHash });

    // Alice funds, approves Permit2 once, grants the module a capped allowance and subscribes.
    const send = async (
      from: Address,
      call: Parameters<ReturnType<typeof wallet>["writeContract"]>[0],
    ) => publicClient.waitForTransactionReceipt({ hash: await wallet(from).writeContract(call) });
    await send(accounts[0]!, {
      address: usdc,
      abi: mockUsdcAbi,
      functionName: "mint",
      args: [alice, 1_000_000_000n],
    });
    await send(alice, {
      address: usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: ["0x000000000022D473030F116dDEE9F6B43aC78BA3", 2n ** 256n - 1n],
    });
    await send(alice, {
      address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      abi: permit2Abi,
      functionName: "approve",
      args: [usdc, autopay, 600_000_000n, 2 ** 47],
    });
    await send(alice, {
      address: autopay,
      abi: autopayModuleAbi,
      functionName: "subscribe",
      args: [1n],
    });

    await indexAll();

    // Merchant's backend talks to the API through the SDK.
    const { apiKey } = await createTeam(db, { name: "Kazim Berber", merchant });
    let apiNow = await chainNow();
    const apiAtChainTime = createApi(db, { chainId: monadTestnet.id, now: () => apiNow });
    const client = new MonaVisaClient({
      apiKey,
      baseUrl: "http://platform.test",
      fetch: async (input, init) =>
        apiAtChainTime.request(input instanceof Request ? input : String(input), init),
    });

    await client.setFeature("pro_tiras", [1]);
    const hookPort = (hooks.address() as AddressInfo).port;
    const endpoint = await client.createWebhookEndpoint(`http://127.0.0.1:${hookPort}/monavisa`);

    expect((await client.checkEntitlement("pro_tiras", { address: alice })).enabled).toBe(true);
    expect((await client.checkEntitlement("pro_tiras", { address: keeper })).enabled).toBe(false);

    // 30 days later the keeper triggers the renewal.
    await testClient.increaseTime({ seconds: 30 * DAY });
    await testClient.mine({ blocks: 1 });
    apiNow = await chainNow();
    const kept = await runKeeperOnce(
      db,
      publicClient,
      wallet(keeper),
      { autopay, batchSize: 10, retryAfterSec: 3600 },
      apiNow,
    );
    expect(kept?.subIds).toEqual([1n]);

    await indexAll();
    const sub = await publicClient.readContract({
      address: deployment.subscriptionRegistry as Address,
      abi: subscriptionRegistryAbi,
      functionName: "getSubscription",
      args: [1n],
    });
    expect(sub.status).toBe(1);
    expect((await client.checkEntitlement("pro_tiras", { address: alice })).enabled).toBe(true);

    const invoices = await client.listInvoices({ address: alice });
    expect(invoices).toHaveLength(2);
    expect(invoices.every((i) => i.amount === PRICE.toString() && i.fee === "490000")).toBe(true);

    // Webhooks: every event so far, signed with the endpoint's secret.
    await fanOutEvents(db, apiNow);
    expect(await deliverDue(db, apiNow)).toMatchObject({ failed: 0 });
    const events: WebhookEvent[] = [];
    for (const msg of received) {
      events.push(await verifyWebhook(msg.body, msg.signature, endpoint.secret!, { now: apiNow }));
    }
    expect(events.map((e) => e.type).sort()).toEqual([
      "invoice.paid",
      "invoice.paid",
      "subscription.created",
      "subscription.renewed",
    ]);
    expect(events.every((e) => e.chainId === monadTestnet.id)).toBe(true);
  }, 120_000);
});
