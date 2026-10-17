import type { ReactNode } from 'react';
import type { ThemeMode } from '../hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';

type Props = {
  cityName: string;
  theme: ThemeMode;
  onToggleTheme: () => void;
  brandSlot?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
};

export function TopBar({
  cityName,
  theme,
  onToggleTheme,
  brandSlot,
  refreshing = false,
  onRefresh,
}: Props) {
  return (
    <header id="topbar" className="topbar" role="banner">
      <div className="topbar-brand">
        {brandSlot ?? <span className="topbar-product">Wohnindex</span>}
        {cityName ? (
          <>
            <span className="topbar-sep" aria-hidden>
              /
            </span>
            <span className="topbar-city" title={cityName}>
              {cityName}
            </span>
          </>
        ) : null}
      </div>

      <nav className="topbar-nav" aria-label="Hauptmenü" />

      <div className="topbar-actions">
        {onRefresh ? (
          <button
            type="button"
            className="topbar-btn"
            onClick={onRefresh}
            disabled={refreshing}
            title="Stadtdaten neu laden und Karte neu zeichnen"
            aria-label="Daten aktualisieren"
          >
            {refreshing ? 'Aktualisiere …' : 'Aktualisieren'}
          </button>
        ) : null}
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
    </header>
  );
}
