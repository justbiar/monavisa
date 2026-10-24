import { MonaVisaProvider } from "@monavisa/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { SessionProvider } from "./api.js";
import { App } from "./App.js";
import { addressOverrides, chainId, wagmiConfig } from "./config.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <MonaVisaProvider
          chainId={chainId}
          {...(addressOverrides ? { addresses: addressOverrides } : {})}
        >
          <SessionProvider>
            <App />
          </SessionProvider>
        </MonaVisaProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
