import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { apiUrl } from "./config.js";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Team {
  id: string;
  name: string;
  merchant: string;
}

const STORAGE_KEY = "monavisa.session";

// sessionStorage keeps the sign-in to this tab; it can throw in private modes, so it is optional.
const storage = {
  get(): string | null {
    try {
      return sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(value: string | null) {
    try {
      if (value) sessionStorage.setItem(STORAGE_KEY, value);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Sign-in still works for this page load.
    }
  },
};

async function request<T>(
  token: string | null,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `Request failed (${res.status})`);
  return json as T;
}

interface Session {
  token: string | null;
  api: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  signIn: (message: string, signature: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(storage.get);

  const signOut = useCallback(async () => {
    if (token) await request(token, "/auth/logout", { method: "POST" }).catch(() => {});
    storage.set(null);
    setToken(null);
  }, [token]);

  const value = useMemo<Session>(
    () => ({
      token,
      api: async <T,>(path: string, init?: { method?: string; body?: unknown }) => {
        try {
          return await request<T>(token, path, init);
        } catch (err) {
          // An expired session drops back to the sign-in screen.
          if (err instanceof ApiError && err.status === 401) {
            storage.set(null);
            setToken(null);
          }
          throw err;
        }
      },
      signIn: async (message, signature) => {
        const res = await request<{ token: string }>(null, "/auth/login", {
          method: "POST",
          body: { message, signature },
        });
        storage.set(res.token);
        setToken(res.token);
      },
      signOut,
    }),
    [token, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

export async function fetchNonce(): Promise<string> {
  return (await request<{ nonce: string }>(null, "/auth/nonce", { method: "POST" })).nonce;
}
