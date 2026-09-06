import { useEffect, useMemo, useState } from 'react';
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
import { PILLAR_LABELS, PILLAR_KEYS } from '../scoring/engine';
import { useTheme } from '../hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';
import { ComparePanel } from './ComparePanel';

const CITY_TYPE_LABELS: Record<string, string> = {
  METROPOLIS: 'Metropole',
  LARGE_CITY: 'Großstadt',
  MEDIUM_CITY: 'Mittelstadt',
  SMALL_CITY: 'Kleinstadt',
  TOWN: 'Stadt',
};

const DATA_SOURCES = [
  {
    title: 'OpenStreetMap',
    text: 'Läden, Cafés, Ärzte, Schulen und weitere Alltagsorte — die Basis für den Infrastruktur-Score.',
  },
];

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

export function HomePage() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [cities, setCities] = useState<CityListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState<{ msg: string; error?: boolean } | null>(null);

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
    const q = filter.trim().toLowerCase();
    if (!q) return cities;
    return cities.filter((c) => {
      const name = (c.name || c.slug || '').toLowerCase();
      const slug = (c.slug || '').toLowerCase();
      const type = (cityTypeLabel(c.city_type) || c.city_type || '').toLowerCase();
      return name.includes(q) || slug.includes(q) || type.includes(q);
    });
  }, [cities, filter]);

  const onSearchNew = async (e: FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const input = form.elements.namedItem('q') as HTMLInputElement;
    const query = String(input.value || '').trim();
    if (!query || searching) return;

    const match = cities.find(
      (c) =>
        (c.name || '').toLowerCase() === query.toLowerCase()
        || (c.slug || '').toLowerCase() === query.toLowerCase(),
    );
    if (match?.slug) {
      navigate(`/city/${encodeURIComponent(match.slug)}`);
      return;
    }

    setSearching(true);
    setSearchStatus({ msg: `Suche „${query}“ …` });
    try {
      const city = await resolveCityByQuery(query, (msg) => setSearchStatus({ msg }));
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

  return (
    <div className="home">
      <header className="home-top">
        <Link to="/" className="home-top-brand">
          Wohnindex
        </Link>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>

      <section className="home-hero" aria-label="Einführung">
        <div className="home-hero-bg" aria-hidden />
        <div className="home-hero-inner">
          <p className="home-hero-brand">Wohnindex</p>
          <h1 className="home-hero-title">Wie gut ist die Infrastruktur hier?</h1>
          <p className="home-hero-lead">
            Infrastruktur-Score für deutsche Städte — Läden, Cafés, Ärzte, Schulen und mehr in
            Gehweite auf einer Karte.
          </p>
          <div className="home-hero-cta">
            <a href="#staedte" className="home-btn home-btn-primary">
              Städte entdecken
            </a>
            <a href="#daten" className="home-btn home-btn-ghost">
              Was steckt in den Daten
            </a>
          </div>
        </div>
      </section>

      <section id="daten" className="home-section home-daten">
        <header className="home-section-head">
          <h2>Was steckt in den Daten</h2>
          <p>
            Jede Stadt wird in Hexagone zerlegt. Daraus entsteht ein Infrastruktur-Score von 0–100 —
            Läden, Cafés, Ärzte, Schulen und weitere Alltagsorte in Gehweite.
          </p>
        </header>

        <ul className="home-pillars" aria-label="Infrastruktur-Metriken">
          {PILLAR_KEYS.map((key) => (
            <li key={key}>
              <span>{PILLAR_LABELS[key as keyof typeof PILLAR_LABELS] || key}</span>
            </li>
          ))}
        </ul>

        <div className="home-sources">
          {DATA_SOURCES.map((s) => (
            <article key={s.title} className="home-source">
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </article>
          ))}
        </div>
      </section>

      <ComparePanel variant="home" />

      <section id="staedte" className="home-section home-cities">
        <header className="home-section-head">
          <h2>Bereite Städte</h2>
          <p>
            Schon berechnete Karten sofort öffnen — oder eine weitere deutsche Stadt anfordern.
          </p>
        </header>

        <div className="home-cities-toolbar">
          <label className="home-filter">
            <span className="visually-hidden">In der Liste filtern</span>
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Liste filtern …"
              autoComplete="off"
            />
          </label>
          <form className="home-search-form" role="search" onSubmit={onSearchNew}>
            <label className="visually-hidden" htmlFor="home-city-q">
              Neue Stadt suchen
            </label>
            <input
              id="home-city-q"
              name="q"
              type="search"
              placeholder="z. B. Hamburg, Köln …"
              autoComplete="off"
              disabled={searching}
            />
            <button type="submit" disabled={searching}>
              {searching ? '…' : 'Los'}
            </button>
          </form>
        </div>

        {searchStatus?.msg ? (
          <p
            className={`home-status${searchStatus.error ? ' is-error' : ''}`}
            role="status"
          >
            {searchStatus.msg}
          </p>
        ) : null}

        {loading ? (
          <p className="home-status">Lade Städte …</p>
        ) : loadError ? (
          <p className="home-status is-error" role="alert">
            {loadError}
          </p>
        ) : filtered.length === 0 ? (
          <p className="home-status">
            {cities.length === 0
              ? 'Noch keine Städte im Cache. Suche oben eine Stadt, um die erste Karte zu erzeugen.'
              : 'Keine Treffer in der Liste — versuche die Freitextsuche rechts.'}
          </p>
        ) : (
          <ul className="home-city-list">
            {filtered.map((c) => {
              const slug = c.slug;
              if (!slug) return null;
              const name = c.name || slug;
              const type = cityTypeLabel(c.city_type);
              const pop = formatPopulation(c.population);
              const hex = typeof c.count === 'number' ? c.count.toLocaleString('de-DE') : null;
              return (
                <li key={slug}>
                  <Link to={`/city/${encodeURIComponent(slug)}`} className="home-city-row">
                    <span className="home-city-name">{name}</span>
                    <span className="home-city-meta">
                      {type ? <span>{type}</span> : null}
                      {pop ? <span>{pop} Einw.</span> : null}
                      {hex ? <span>{hex} Hex</span> : null}
                      {c.has_rent ? <span className="home-city-tag">Miete</span> : null}
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
