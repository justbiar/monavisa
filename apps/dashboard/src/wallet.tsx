import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useConnect, useConnection, useConnectors } from "wagmi";
import { type Team, useSession } from "./api.js";
import { short } from "./format.js";

export function connectorLabel(connector: { type: string; name: string }): string {
  if (connector.type === "mock") return "Dev cüzdanı (anvil)";
  if (connector.name === "Injected") return "Tarayıcı cüzdanı (MetaMask, Rabby…)";
  return connector.name;
}

/**
 * On-chain actions (creating a plan, pausing sales) must come from the merchant wallet the team
 * signed in with, or the plan would belong to someone else.
 */
export function WalletRequired({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ team: Team }>("/v1/me") });
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const merchant = me.data?.team.merchant;

  if (connection.status !== "connected") {
    return (
      <div className="stack tight">
        <p className="muted small">Zincirdeki işlemler için satıcı cüzdanını bağla.</p>
        {connectors.map((connector) => (
          <button
            key={connector.uid}
            type="button"
            className="btn wallet"
            disabled={connect.isPending}
            onClick={() => connect.mutate({ connector })}
          >
            {connectorLabel(connector)}
          </button>
        ))}
      </div>
    );
  }
  if (merchant && connection.address.toLowerCase() !== merchant) {
    return (
      <div className="notice warn">
        Bağlı cüzdan ({short(connection.address)}) bu mağazanın satıcı cüzdanı değil (
        {short(merchant)}). Satıcı cüzdanına geç.
      </div>
    );
  }
  return <>{children}</>;
}
