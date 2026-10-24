import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { createSiweMessage } from "viem/siwe";
import {
  useBlockNumber,
  useConfig,
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
} from "wagmi";
import { signMessage } from "wagmi/actions";
import { fetchNonce, type Team, useSession } from "./api.js";
import { chain, isMainnet, networkName, otherNetworkUrl } from "./config.js";
import { short } from "./format.js";
import { Features } from "./pages/Features.js";
import { Links } from "./pages/Links.js";
import { Overview } from "./pages/Overview.js";
import { Payments } from "./pages/Payments.js";
import { Plans } from "./pages/Plans.js";
import { Settings } from "./pages/Settings.js";
import { Subscribers } from "./pages/Subscribers.js";
import { NavLink, PAGES, usePage } from "./router.js";
import { connectorLabel } from "./wallet.js";

export function App() {
  const { token } = useSession();
  return token ? <Shell /> : <SignIn />;
}

function Shell() {
  const page = usePage();
  const { api, signOut } = useSession();
  const disconnect = useDisconnect();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ team: Team }>("/v1/me") });

  return (
    <>
      <header className="nav">
        <div className="wrap nav-row">
          <span className="brand">Mona Visa</span>
          <nav className="tabs" aria-label="Panel">
            {PAGES.map((p) => (
              <NavLink key={p.page} to={p.path} current={page === p.page}>
                {p.label}
              </NavLink>
            ))}
          </nav>
          <div className="account">
            <span className="dot" aria-hidden="true" />
            <span className="nav-meta">{me.data?.team.name ?? "…"}</span>
            <button
              type="button"
              className="link"
              onClick={async () => {
                await signOut();
                disconnect.mutate();
              }}
            >
              Çıkış
            </button>
          </div>
        </div>
      </header>
      <LiveStrip merchant={me.data?.team.merchant ?? null} />
      <main className="wrap page">
        {page === "overview" && <Overview />}
        {page === "plans" && <Plans />}
        {page === "subscribers" && <Subscribers />}
        {page === "payments" && <Payments />}
        {page === "links" && <Links />}
        {page === "features" && <Features />}
        {page === "settings" && <Settings />}
      </main>
    </>
  );
}

/** Dark ticker band: network, the chain's live block, how far the index has caught up. */
function LiveStrip({ merchant }: { merchant: string | null }) {
  const { api } = useSession();
  const { data: block } = useBlockNumber({ chainId: chain.id, watch: true });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ lastIndexedBlock: string | null }>("/health"),
    refetchInterval: 3000,
  });
  const indexed = health.data?.lastIndexedBlock;
  return (
    <div className="strip" aria-label="Ağ durumu">
      <div className="wrap strip-row">
        <span>
          <em>Ağ</em> {networkName}
          {otherNetworkUrl && (
            <a className="strip-link" href={otherNetworkUrl}>
              {isMainnet ? "Testnet'e geç" : "Mainnet'e geç"}
            </a>
          )}
        </span>
        <span>
          <em>Blok</em> <i className="live" aria-hidden="true" />
          <span className="num">
            {block === undefined ? "…" : `#${block.toLocaleString("tr-TR")}`}
          </span>
        </span>
        <span>
          <em>Index</em>
          <span className="num">
            {indexed ? `#${BigInt(indexed).toLocaleString("tr-TR")}` : "bekleniyor"}
          </span>
        </span>
        {merchant && (
          <span>
            <em>Satıcı</em>
            <span className="mono">{short(merchant)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/** Sign-In with Ethereum: the merchant's wallet is the account. No password, no email. */
function SignIn() {
  const config = useConfig();
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const { signIn } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (connection.status !== "connected") return;
    setPending(true);
    setError(null);
    try {
      const message = createSiweMessage({
        domain: window.location.host,
        address: connection.address,
        statement: "Mona Visa satıcı paneline giriş yapıyorum.",
        uri: window.location.origin,
        version: "1",
        chainId: chain.id,
        nonce: await fetchNonce(),
        issuedAt: new Date(),
        expirationTime: new Date(Date.now() + 10 * 60 * 1000),
      });
      const signature = await signMessage(config, { message });
      await signIn(message, signature);
    } catch (err) {
      const e = err as { shortMessage?: string; message?: string };
      setError(e.shortMessage ?? e.message ?? "Giriş yapılamadı");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <header className="nav">
        <div className="wrap nav-row">
          <span className="brand">Mona Visa</span>
          <span className="nav-meta">Satıcı paneli</span>
        </div>
      </header>
      <main className="wrap signin">
        <div className="signin-copy">
          <h1>Aboneliklerini tek yerden yönet.</h1>
          <p>
            Planlarını, abonelerini ve ödemelerini gör. Giriş için cüzdanınla bir mesaj imzalarsın.
            İşlem değildir, gas ödemezsin.
          </p>
        </div>
        <section className="panel stack" aria-label="Giriş">
          {connection.status !== "connected" ? (
            <>
              <h2>Cüzdanını bağla</h2>
              <p className="muted">Planları oluşturduğun satıcı cüzdanını kullan.</p>
              <div className="stack tight">
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
              {connect.error && (
                <div className="notice error">{connect.error.message.split("\n")[0]}</div>
              )}
            </>
          ) : (
            <>
              <h2>Panele giriş yap</h2>
              <div className="account">
                <span className="dot" aria-hidden="true" />
                <span className="mono">{short(connection.address)}</span>
                <button type="button" className="link push" onClick={() => disconnect.mutate()}>
                  Başka cüzdan
                </button>
              </div>
              <button type="button" className="btn primary big" disabled={pending} onClick={start}>
                {pending ? "Cüzdanında imzala…" : "İmzala ve giriş yap"}
              </button>
              {error && <div className="notice error">{error}</div>}
            </>
          )}
        </section>
      </main>
    </>
  );
}
