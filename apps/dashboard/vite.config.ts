import { existsSync, readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// With VITE_USE_LOCAL_DEPLOYMENT=1, addresses come from contracts/deployments/local.json
// (written by script/DeployLocal.s.sol against an anvil fork).
const localDeploymentPath = new URL("../../contracts/deployments/local.json", import.meta.url);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const useLocal = env.VITE_USE_LOCAL_DEPLOYMENT === "1";
  if (useLocal && !existsSync(localDeploymentPath)) {
    throw new Error(
      "VITE_USE_LOCAL_DEPLOYMENT=1 but contracts/deployments/local.json does not exist",
    );
  }
  const local = useLocal ? JSON.parse(readFileSync(localDeploymentPath, "utf8")) : null;
  return {
    plugins: [react()],
    define: { __LOCAL_DEPLOYMENT__: JSON.stringify(local) },
    server: { port: 5174 },
  };
});
