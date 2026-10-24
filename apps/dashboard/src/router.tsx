import { type MouseEvent, type ReactNode, useEffect, useState } from "react";

export type Page = "overview" | "plans" | "subscribers" | "payments" | "links" | "settings";

export const PAGES: { page: Page; path: string; label: string }[] = [
  { page: "overview", path: "/", label: "Genel bakış" },
  { page: "plans", path: "/plans", label: "Planlar" },
  { page: "subscribers", path: "/subscribers", label: "Aboneler" },
  { page: "payments", path: "/payments", label: "Ödemeler" },
  { page: "links", path: "/links", label: "Linkler" },
  { page: "settings", path: "/settings", label: "Ayarlar" },
];

const pageFor = (path: string): Page => {
  const clean = path.replace(/\/+$/, "") || "/";
  return PAGES.find((p) => p.path === clean)?.page ?? "overview";
};

export function usePage(): Page {
  const [page, setPage] = useState(() => pageFor(window.location.pathname));
  useEffect(() => {
    const onPop = () => setPage(pageFor(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return page;
}

export function navigate(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function NavLink({
  to,
  current,
  children,
}: {
  to: string;
  current: boolean;
  children: ReactNode;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className="link" aria-current={current ? "page" : undefined} onClick={onClick}>
      {children}
    </a>
  );
}
