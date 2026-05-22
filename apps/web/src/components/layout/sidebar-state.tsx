"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Client-side toggle state for the desktop sidebar.
 *
 * Persisted to `localStorage` so the choice survives refresh (collapsed
 * admins stay collapsed). Kept as a tiny dedicated context rather than
 * a zustand store — two fields, no middleware, no cross-tree reads.
 *
 * Mobile uses its own drawer (`MobileDrawer`) — this state only drives
 * the md-and-up sidebar.
 */

const STORAGE_KEY = "ac.sidebar.collapsed";

interface SidebarCtx {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
}

const Ctx = createContext<SidebarCtx | null>(null);

export function SidebarStateProvider({ children }: { children: ReactNode }) {
  // Start expanded. We hydrate from localStorage on mount — reading
  // synchronously during render would break SSR (no `window`).
  const [collapsed, setCollapsedState] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "1") setCollapsedState(true);
    } catch {
      // localStorage disabled / private-mode — keep default.
    }
  }, []);

  const setCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      // Ignore storage failures — UI still updates in memory.
    }
  }, []);

  const toggle = useCallback(() => {
    setCollapsed(!collapsed);
  }, [collapsed, setCollapsed]);

  const value = useMemo<SidebarCtx>(
    () => ({ collapsed, toggle, setCollapsed }),
    [collapsed, toggle, setCollapsed],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSidebarState(): SidebarCtx {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error(
      "useSidebarState must be used inside <SidebarStateProvider>",
    );
  }
  return v;
}
