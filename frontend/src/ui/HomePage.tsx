import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  apiUnavailableMessage,
  fetchCities,
  isAbortError,
  resetApiBase,
  type CityListItem,
} from '../api/client';
import { resolveCityByQuery } from '../api/city';
import { DAILY_LIFE_GROUP_WEIGHTS } from '../scoring/engine';
import { useTheme } from '../hooks/useTheme';
import { Brand } from './Brand';
import { ThemeToggle } from './ThemeToggle';
import { ComparePanel } from './ComparePanel';

const CITY_TYPE_LABELS: Record<string, string> = {
  METROPOLIS: 'Metropole',
  LARGE_CITY: 'Großstadt',
  MEDIUM_CITY: 'Mittelstadt',
  SMALL_CITY: 'Kleinstadt',
  TOWN: 'Stadt',
};

const GROUP_LABELS: Record<string, string> = {
  food: 'Einkaufen',
  health: 'Gesundheit',
  education: 'Bildung',
  services: 'Versorgung',
  restaurants_cafes: 'Gastronomie',
  leisure: 'Freizeit',
};

const HOW_STEPS = [
  { n: '01', title: 'Stadt öffnen', text: 'Liste filtern oder eine neue Karte anfordern.' },
  { n: '02', title: 'Hexagon klicken', text: 'Score, Gehzeiten und Alltag auf ~250 m.' },
  { n: '03', title: 'Orte merken', text: 'Vergleichen — auch über Städte hinweg.' },
] as const;

function formatPopulation(n: number | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio.`
    : n.toLocaleString('de-DE');
}

function cityTypeLabel(t: string | undefined): string | null {
  if (!t) return null;
  return CITY_TYPE_LABELS[t] || t;
}

function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const a = ((-90 + i * 60) * Math.PI) / 180;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

function WalkHexFigure() {
  const cx = 140;
  const cy = 148;
  return (
    <svg className="home-figure-svg" viewBox="0 0 280 280" aria-hidden>
      <defs>
        <linearGradient id="hex-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--water)" stopOpacity="0.08" />
        </linearGradient>
      </defs>
      <polygon className="home-hex home-hex-20" points={hexPoints(cx, cy, 118)} />
      <polygon className="home-hex home-hex-15" points={hexPoints(cx, cy, 90)} />
      <polygon className="home-hex home-hex-10" points={hexPoints(cx, cy, 62)} />
      <polygon className="home-hex home-hex-5" points={hexPoints(cx, cy, 36)} fill="url(#hex-fill)" />
      <text x={cx} y={cy + 6} textAnchor="middle" className="home-hex-label is-core">
        5
      </text>
      <text x={cx} y={24} textAnchor="middle" className="home-hex-caption">
        Gehminuten
      </text>
    </svg>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [cities, setCities] = useState<CityListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState<{ msg: string; error?: boolean } | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [heroSearchVisible, setHeroSearchVisible] = useState(true);
  const heroSearchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = heroSearchRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setHeroSearchVisible(Boolean(entry?.isIntersecting)),
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        resetApiBase();
        const list = await fetchCities();
        if (!cancelled) setCities(list);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : apiUnavailableMessage());
          setCities([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cities;
    return cities.filter((c) => {
      const name = (c.name || c.slug || '').toLowerCase();
      const slug = (c.slug || '').toLowerCase();
      const type = (cityTypeLabel(c.city_type) || c.city_type || '').toLowerCase();
      return name.includes(q) || slug.includes(q) || type.includes(q);
    });
  }, [cities, query]);

  const onSearch = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (searching) return;
    if (!q) {
      document.getElementById('staedte')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    const match = cities.find(
      (c) =>
        (c.name || '').toLowerCase() === q.toLowerCase()
        || (c.slug || '').toLowerCase() === q.toLowerCase(),
    );
    if (match?.slug) {
      navigate(`/city/${encodeURIComponent(match.slug)}`);
      return;
    }

    setSearching(true);
    setSearchStatus({ msg: `Suche „${q}“ …` });
    try {
      const city = await resolveCityByQuery(q, (msg) => setSearchStatus({ msg }));
      navigate(`/city/${encodeURIComponent(city.slug)}`);
    } catch (err) {
      if (isAbortError(err)) return;
      setSearchStatus({
        msg: err instanceof Error ? err.message : 'Suche fehlgeschlagen',
        error: true,
      });
    } finally {
      setSearching(false);
    }
  };

  const searchForm = (id: string, compact = false) => (
    <form className={`home-search${compact ? ' is-compact' : ''}`} role="search" onSubmit={onSearch}>
      <label className="visually-hidden" htmlFor={id}>
        Stadt suchen
      </label>
      <input
        id={id}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Stadt suchen — Hamburg, Köln, Leipzig …"
        autoComplete="off"
        disabled={searching}
      />
      <button type="submit" disabled={searching}>
        {searching ? '…' : 'Öffnen'}
      </button>
    </form>
  );

  return (
    <div className="home">
      <a className="skip-link" href="#staedte">
        Zu den Städten
      </a>
      <header className={`home-top${scrolled ? ' is-scrolled' : ''}`}>
        <Brand />
        <nav className="home-top-nav" aria-label="Seite">
          <a href="#staedte">Städte</a>
          <a href="#methode">Methode</a>
        </nav>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>

      <section className="home-hero" aria-label="Einführung">
        <div className="home-hero-bg" aria-hidden />
        <div className="home-hero-stage">
          <div className="home-hero-copy">
            <p className="home-kicker">15-Minuten-Stadt · Deutschland</p>
            <h1 className="home-hero-brand">Wohnindex</h1>
            <p className="home-hero-title">Wie gut lebt es sich hier ohne Auto?</p>
            <p className="home-hero-lead">
              Infrastruktur in Gehweite auf einer Hexagon-Karte. Läden, Cafés, Ärzte, Schulen —
              ein Score von 0–100, erklärt und vergleichbar.
            </p>
            <div ref={heroSearchRef}>
              {searchForm('home-city-q')}
            </div>
            <p className="home-search-hint">
              Tippen filtert die Liste. Enter öffnet die Stadt oder berechnet eine neue Karte.
            </p>
          </div>
          <div className="home-hero-aside">
            <WalkHexFigure />
            <ul className="home-walk-key">
              <li>
                <b>0–5 Min.</b> voller Score
              </li>
              <li>
                <b>10 Min.</b> 70
              </li>
              <li>
                <b>15 Min.</b> 30
              </li>
              <li>
                <b>≥ 20 Min.</b> 0
              </li>
            </ul>
          </div>
        </div>
      </section>

      <ol className="home-steps" aria-label="So funktioniert’s">
        {HOW_STEPS.map((step) => (
          <li key={step.n}>
            <span className="home-step-n">{step.n}</span>
            <strong>{step.title}</strong>
            <span>{step.text}</span>
          </li>
        ))}
      </ol>

      <section id="staedte" className="home-section home-cities">
        <header className="home-section-head">
          <p className="home-kicker">Atlas</p>
          <h2>Bereite Städte</h2>
          <p>Berechnete Karten sofort öffnen — oder eine weitere deutsche Stadt anfordern.</p>
        </header>

        {!heroSearchVisible ? searchForm('home-city-q-list', true) : null}

        {searchStatus?.msg ? (
          <p
            className={`home-status${searchStatus.error ? ' is-error' : ''}`}
            role="status"
          >
            {searchStatus.msg}
          </p>
        ) : null}

        {loading ? (
          <ul className="home-city-grid" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="home-city-card is-skeleton" />
            ))}
          </ul>
        ) : loadError ? (
          <p className="home-status is-error" role="alert">
            {loadError}
          </p>
        ) : filtered.length === 0 ? (
          <p className="home-status">
            {cities.length === 0
              ? 'Noch keine Städte im Cache. Suche oben eine Stadt, um die erste Karte zu erzeugen.'
              : 'Keine Treffer in der Liste — Enter sucht die Stadt neu.'}
          </p>
        ) : (
          <ul className="home-city-grid">
            {filtered.map((c) => {
              const slug = c.slug;
              if (!slug) return null;
              const name = c.name || slug;
              const type = cityTypeLabel(c.city_type);
              const pop = formatPopulation(c.population);
              const hex = typeof c.count === 'number' ? c.count.toLocaleString('de-DE') : null;
              return (
                <li key={slug}>
                  <Link to={`/city/${encodeURIComponent(slug)}`} className="home-city-card">
                    <span className="home-city-hex" aria-hidden />
                    <span className="home-city-body">
                      <span className="home-city-name">{name}</span>
                      <span className="home-city-meta">
                        {type ? <span className="home-chip">{type}</span> : null}
                        {pop ? <span>{pop} Einw.</span> : null}
                        {hex ? <span className="mono">{hex} Hex</span> : null}
                        {c.has_rent ? <span className="home-chip is-brick">Miete</span> : null}
                      </span>
                    </span>
                    <span className="home-city-go" aria-hidden>
                      →
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {!loading && !loadError && cities.length > 0 ? (
          <p className="home-cities-count">
            {filtered.length === cities.length
              ? `${cities.length} Städte bereit`
              : `${filtered.length} von ${cities.length} Städten`}
          </p>
        ) : null}
      </section>

      <ComparePanel variant="home" />

      <section id="methode" className="home-section home-daten">
        <header className="home-section-head">
          <p className="home-kicker">Methode</p>
          <h2>Was in den Daten steckt</h2>
          <p>
            Jede Stadt wird in H3-Hexagone zerlegt (~250 m). Der Infrastruktur-Score zählt
            Alltagsorte in Gehweite — nicht Autonähe.
          </p>
        </header>

        <ul className="home-pillars" aria-label="Alltagsgruppen">
          {Object.entries(DAILY_LIFE_GROUP_WEIGHTS).map(([key, weight]) => (
            <li key={key}>
              <span>{GROUP_LABELS[key] || key}</span>
              <b>{Math.round(weight * 100)}%</b>
            </li>
          ))}
        </ul>

        <div className="home-sources">
          <article className="home-source">
            <h3>OpenStreetMap</h3>
            <p>
              Läden, Cafés, Ärzte, Schulen und weitere Alltagsorte — die Basis für den
              Infrastruktur-Score.
            </p>
          </article>
          <article className="home-source">
            <h3>Hex-Tessellation</h3>
            <p>
              Statt Stadtteilen: vergleichbare Zellen. Ein Klick merkt den Ort für Vergleich und
              Chat.
            </p>
          </article>
          <article className="home-source">
            <h3>Gehzeit-Bänder</h3>
            <p>
              Piecewise, nicht exponentiell: 0–5 Minuten voll, dann abfallend bis 20 Minuten auf
              null.
            </p>
          </article>
        </div>
      </section>

      <footer className="home-foot">
        <nav>
          <a href="/legal/impressum.html">Impressum</a>
          {' · '}
          <a href="/legal/datenschutz.html">Datenschutz</a>
        </nav>
        <p>
          Daten ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
            OpenStreetMap
          </a>
          , Zensus 2022, GTFS (Mobilithek). Informativ, keine Rechts-/Immobilienberatung.
        </p>
      </footer>
    </div>
  );
}
