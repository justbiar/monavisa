import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const deployer = JSON.parse(readFileSync(".deployer.json", "utf8"));
const userAdmin = "0x232bae5d6548f9f01a4152584498497683e24a5a";

console.log(`Checking balance for ${deployer.address}...`);

const res = await fetch("https://testnet-rpc.monad.xyz", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getBalance",
    params: [deployer.address, "latest"],
  }),
});
const { result } = await res.json();
const balance = BigInt(result);
console.log(`Current Balance: ${Number(balance) / 1e18} MON`);

if (balance < 500000000000000000n) {
  console.log("Balance too low! Please send at least 1-2 MON.");
  process.exit(1);
}

console.log("Deploying Mona Visa contracts to Monad Testnet (10143)...");
const cmd = `ADMIN=${userAdmin} TREASURY=${userAdmin} forge script script/DeployMonaVisa.s.sol:DeployMonaVisa --rpc-url https://testnet-rpc.monad.xyz --private-key ${deployer.privateKey} --broadcast --legacy`;

const output = execSync(cmd, {
  cwd: "contracts",
  encoding: "utf8",
  env: { ...process.env, PATH: `${process.env.PATH}:/Users/biar/.foundry/bin` },
});
console.log(output);

// Parse console.log outputs from DeployMonaVisa:
// FeeCollector         0x...
// PlanFactory          0x...
// SubscriptionRegistry 0x...
// AutopayModule        0x...
// SessionVault         0x...

const feeCollector = output.match(/FeeCollector\s+(0x[a-fA-F0-9]{40})/)?.[1];
const planFactory = output.match(/PlanFactory\s+(0x[a-fA-F0-9]{40})/)?.[1];
const subscriptionRegistry = output.match(/SubscriptionRegistry\s+(0x[a-fA-F0-9]{40})/)?.[1];
const autopayModule = output.match(/AutopayModule\s+(0x[a-fA-F0-9]{40})/)?.[1];
const sessionVault = output.match(/SessionVault\s+(0x[a-fA-F0-9]{40})/)?.[1];

console.log("Parsed Deployed Addresses:", {
  feeCollector,
  planFactory,
  subscriptionRegistry,
  autopayModule,
  sessionVault,
});

if (planFactory && subscriptionRegistry && autopayModule) {
  const deployment = {
    chainId: 10143,
    feeCollector,
    planFactory,
    subscriptionRegistry,
    autopayModule,
    sessionVault,
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  };

  writeFileSync("contracts/deployments/local.json", JSON.stringify(deployment, null, 2));
  console.log("Updated contracts/deployments/local.json successfully!");

  // Update packages/core/src/networks.ts
  const networksPath = "packages/core/src/networks.ts";
  let networksSrc = readFileSync(networksPath, "utf8");
  const contractsBlock = `contracts: {
      planFactory: "${planFactory}",
      subscriptionRegistry: "${subscriptionRegistry}",
      autopayModule: "${autopayModule}",
      feeCollector: "${feeCollector}",
      sessionVault: "${sessionVault}",
    },`;
  networksSrc = networksSrc.replace(
    /\[MONAD_TESTNET_CHAIN_ID\]: \{[\s\S]*?contracts:\s*NOT_DEPLOYED,/,
    (match) => match.replace("contracts: NOT_DEPLOYED,", contractsBlock),
  );
  writeFileSync(networksPath, networksSrc);
  console.log("Updated packages/core/src/networks.ts successfully!");

  execSync("corepack pnpm --filter @monavisa/core build", { stdio: "inherit" });
  console.log("Rebuilt @monavisa/core!");
}

console.log("Deployment completed successfully!");

