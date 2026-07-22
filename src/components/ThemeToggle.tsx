"use client";

import { useEffect, useState } from "react";
import styles from "./ThemeToggle.module.css";

type Theme = "dark" | "light";

const THEME_STORAGE_KEY = "voiceover-film-enhancer-theme";
const THEME_COLORS: Record<Theme, string> = {
  dark: "#0d1418",
  light: "#ffffff",
};

const isTheme = (value: string | null): value is Theme => value === "dark" || value === "light";

const applyTheme = (nextTheme: Theme) => {
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;

  const themeColor = THEME_COLORS[nextTheme];
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  meta?.setAttribute("content", themeColor);
};

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const appliedTheme = document.documentElement.dataset.theme;
    const syncFrame = window.requestAnimationFrame(() => {
      setTheme(appliedTheme === "light" ? "light" : "dark");
    });

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;

      const nextTheme: Theme = isTheme(event.newValue) ? event.newValue : "dark";
      applyTheme(nextTheme);
      setTheme(nextTheme);
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      window.cancelAnimationFrame(syncFrame);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const nextTheme: Theme = theme === "dark" ? "light" : "dark";
  const label = nextTheme === "light" ? "Use light theme" : "Use dark theme";

  const handleToggle = () => {
    const currentTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const nextTheme: Theme = currentTheme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    setTheme(nextTheme);

    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The selected theme still applies for this page when storage is unavailable.
    }
  };

  return (
    <button
      type="button"
      className={styles.toggle}
      aria-label={label}
      title={label}
      onClick={handleToggle}
    >
      <span className={styles.icon} aria-hidden="true">
        {nextTheme === "light" ? "☀" : "◐"}
      </span>
      <span className={styles.label}>{nextTheme === "light" ? "Light" : "Dark"}</span>
    </button>
  );
}
