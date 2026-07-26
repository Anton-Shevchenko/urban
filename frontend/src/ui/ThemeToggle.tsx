import type { ThemeMode } from '../hooks/useTheme';

type Props = {
  theme: ThemeMode;
  onToggle: () => void;
  className?: string;
};

/** Animated sun ↔ moon control for light/dark theme. */
export function ThemeToggle({ theme, onToggle, className }: Props) {
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className={`theme-toggle${className ? ` ${className}` : ''}`}
      aria-pressed={dark}
      aria-label={dark ? 'Hellen Modus einschalten' : 'Nachtmodus einschalten'}
      title={dark ? 'Hellen Modus' : 'Nachtmodus'}
      onClick={onToggle}
    >
      <span className="theme-toggle-track" aria-hidden>
        <span className={`theme-toggle-orb${dark ? ' is-dark' : ''}`}>
          <svg className="theme-icon theme-icon-sun" viewBox="0 0 24 24" width="14" height="14">
            <circle cx="12" cy="12" r="4" fill="currentColor" />
            <g stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <line x1="12" y1="2.5" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="21.5" />
              <line x1="2.5" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="21.5" y2="12" />
              <line x1="5.2" y1="5.2" x2="7" y2="7" />
              <line x1="17" y1="17" x2="18.8" y2="18.8" />
              <line x1="18.8" y1="5.2" x2="17" y2="7" />
              <line x1="7" y1="17" x2="5.2" y2="18.8" />
            </g>
          </svg>
          <svg className="theme-icon theme-icon-moon" viewBox="0 0 24 24" width="14" height="14">
            <path
              fill="currentColor"
              d="M14.5 3.2a8.6 8.6 0 0 0-1.1.07 7.8 7.8 0 1 0 7.43 9.9A6.4 6.4 0 0 1 14.5 3.2z"
            />
          </svg>
        </span>
      </span>
    </button>
  );
}
