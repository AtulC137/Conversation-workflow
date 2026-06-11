import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type StudioAccent = "zinc" | "violet" | "emerald" | "rose" | "blue" | "amber";

const LEGACY_THEME_KEY = "studio-theme";
const ACCENT_KEY = "studio-accent";

type AccentTokens = {
  primary: string;
  primaryForeground: string;
  ring: string;
};

const ACCENT_PRESETS: Record<StudioAccent, AccentTokens> = {
  zinc: {
    primary: "oklch(0.18 0.005 270)",
    primaryForeground: "oklch(0.99 0 0)",
    ring: "oklch(0.55 0.01 270)",
  },
  violet: {
    primary: "oklch(0.52 0.22 295)",
    primaryForeground: "oklch(0.99 0 0)",
    ring: "oklch(0.52 0.22 295)",
  },
  emerald: {
    primary: "oklch(0.55 0.15 155)",
    primaryForeground: "oklch(0.99 0 0)",
    ring: "oklch(0.55 0.15 155)",
  },
  rose: {
    primary: "oklch(0.58 0.2 15)",
    primaryForeground: "oklch(0.99 0 0)",
    ring: "oklch(0.58 0.2 15)",
  },
  blue: {
    primary: "oklch(0.52 0.18 250)",
    primaryForeground: "oklch(0.99 0 0)",
    ring: "oklch(0.52 0.18 250)",
  },
  amber: {
    primary: "oklch(0.68 0.16 75)",
    primaryForeground: "oklch(0.2 0.03 75)",
    ring: "oklch(0.68 0.16 75)",
  },
};

export function applyStudioAccent(accent: StudioAccent) {
  const root = document.documentElement;
  root.classList.remove("dark");
  const tokens = ACCENT_PRESETS[accent];
  root.style.setProperty("--primary", tokens.primary);
  root.style.setProperty("--primary-foreground", tokens.primaryForeground);
  root.style.setProperty("--ring", tokens.ring);
}

function readStoredAccent(): StudioAccent {
  const v = localStorage.getItem(ACCENT_KEY);
  if (v && v in ACCENT_PRESETS) return v as StudioAccent;
  return "zinc";
}

type StudioThemeContextValue = {
  accent: StudioAccent;
  setAccent: (accent: StudioAccent) => void;
};

const StudioThemeContext = createContext<StudioThemeContextValue | null>(null);

export function StudioThemeProvider({ children }: { children: ReactNode }) {
  const [accent, setAccentState] = useState<StudioAccent>(() =>
    typeof window !== "undefined" ? readStoredAccent() : "zinc",
  );

  const setAccent = useCallback((next: StudioAccent) => {
    setAccentState(next);
    localStorage.setItem(ACCENT_KEY, next);
  }, []);

  useEffect(() => {
    localStorage.removeItem(LEGACY_THEME_KEY);
    document.documentElement.classList.remove("dark");
    applyStudioAccent(accent);
  }, [accent]);

  const value = useMemo(() => ({ accent, setAccent }), [accent, setAccent]);

  return (
    <StudioThemeContext.Provider value={value}>{children}</StudioThemeContext.Provider>
  );
}

export function useStudioTheme() {
  const ctx = useContext(StudioThemeContext);
  if (!ctx) throw new Error("useStudioTheme must be used within StudioThemeProvider");
  return ctx;
}

export const STUDIO_ACCENTS: { id: StudioAccent; label: string; swatch: string }[] = [
  { id: "zinc", label: "Zinc", swatch: "oklch(0.45 0.01 270)" },
  { id: "violet", label: "Violet", swatch: "oklch(0.52 0.22 295)" },
  { id: "emerald", label: "Emerald", swatch: "oklch(0.55 0.15 155)" },
  { id: "rose", label: "Rose", swatch: "oklch(0.58 0.2 15)" },
  { id: "blue", label: "Blue", swatch: "oklch(0.52 0.18 250)" },
  { id: "amber", label: "Amber", swatch: "oklch(0.68 0.16 75)" },
];
