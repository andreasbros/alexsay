import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

export type Appearance = "light" | "dark";
const KEY = "ay-theme";

function initial(): Appearance {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") {
      return saved;
    }
  } catch {}
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const AppearanceContext = createContext<{ appearance: Appearance; toggle: () => void }>({
  appearance: "dark",
  toggle: () => {},
});

export function AppearanceProvider({ children }: { children: (appearance: Appearance) => ReactNode }) {
  const [appearance, setAppearance] = useState(initial);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, appearance);
    } catch {}
  }, [appearance]);
  const toggle = () => setAppearance((a) => (a === "dark" ? "light" : "dark"));
  return <AppearanceContext value={{ appearance, toggle }}>{children(appearance)}</AppearanceContext>;
}

export const useAppearance = () => useContext(AppearanceContext);
