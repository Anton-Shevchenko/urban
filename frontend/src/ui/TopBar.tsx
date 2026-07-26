import type { ReactNode } from 'react';
import type { ThemeMode } from '../hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';

type Props = {
  cityName: string;
  theme: ThemeMode;
  onToggleTheme: () => void;
  brandSlot?: ReactNode;
};

export function TopBar({
  cityName,
  theme,
  onToggleTheme,
  brandSlot,
}: Props) {
  return (
    <header id="topbar" className="topbar" role="banner">
      <div className="topbar-brand">
        {brandSlot ?? <span className="topbar-product">Wohnindex</span>}
        <span className="topbar-city" title={cityName}>
          {cityName}
        </span>
      </div>

      <nav className="topbar-nav" aria-label="Hauptmenü" />

      <div className="topbar-actions">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
    </header>
  );
}
