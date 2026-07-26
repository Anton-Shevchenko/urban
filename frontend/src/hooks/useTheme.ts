import { useCallback, useEffect, useState } from 'react';
import { CFG, STORAGE } from '../scoring/constants';

export type ThemeMode = 'light' | 'dark';

function readStoredTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE.theme);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    /* */
  }
  return 'light';
}

function applyThemeAttr(theme: ThemeMode) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const initial = readStoredTheme();
    applyThemeAttr(initial);
    return initial;
  });

  useEffect(() => {
    applyThemeAttr(theme);
    try {
      localStorage.setItem(STORAGE.theme, theme);
    } catch {
      /* */
    }
  }, [theme]);

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const mapStyleUrl = theme === 'dark' ? CFG.styleUrlDark : CFG.styleUrl;

  return { theme, setTheme, toggleTheme, mapStyleUrl };
}
