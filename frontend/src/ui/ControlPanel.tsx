import { useMemo } from 'react';
import type { FormEvent } from 'react';
import { useCityData, useMapViewState, useWeights } from '../wohnindex';

type Props = {
  onClose: () => void;
};

export function ControlPanel({ onClose }: Props) {
  const { cityName, meta, features, hasRent, searchStatus, searching, runSearch } = useCityData();
  const {
    desiredAreaM2,
    setDesiredAreaM2,
    maxMonthlyBudget,
    setMaxMonthlyBudget,
  } = useWeights();
  const {
    setMapView,
    mapViewOptions,
    showHiddenGems,
    setShowHiddenGems,
  } = useMapViewState();

  const hasVoi = Boolean(
    (meta as { has_value_opportunity?: boolean }).has_value_opportunity
    || features.some((f) => {
      const p = f.properties as Record<string, unknown> | null;
      if (!p) return false;
      const cls = String(p.voi_class || '');
      return (
        cls === 'hidden_gem'
        || cls === 'good_value'
        || cls === 'overpriced'
        || Number(p.voi_highlight) > 0
      );
    }),
  );

  const legendNote = useMemo(() => (
    'Infrastruktur · Läden, Cafés, Ärzte, Schulen u. a. · absolute 0–100 · 85–100 Excellent · 70–84 Good · 55–69 Average · 40–54 Below average · 0–39 Poor · grau = Insufficient data'
  ), []);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const input = form.elements.namedItem('q') as HTMLInputElement;
    runSearch(input.value);
  };

  const cityType = (meta as { city_type?: string }).city_type;

  return (
    <aside id="panel" aria-label="Steuerung">
      <header className="panel-head">
        <div className="panel-head-text">
          <h1>{cityName}</h1>
          <p className="subtitle">
            Infrastruktur · Läden, Cafés, Services · 0–100
            {cityType ? ` · ${cityType}` : ''}
          </p>
        </div>
        <button
          type="button"
          className="panel-close"
          onClick={onClose}
          title="Seitenleiste ausblenden"
          aria-label="Seitenleiste ausblenden"
          aria-controls="panel"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <path
              fill="currentColor"
              d="M15.5 5.5a1 1 0 0 1 0 1.4L10.4 12l5.1 5.1a1 1 0 1 1-1.4 1.4l-5.8-5.8a1 1 0 0 1 0-1.4l5.8-5.8a1 1 0 0 1 1.4 0z"
            />
          </svg>
        </button>
      </header>

      <section className="search">
        <span className="section-label">Stadt suchen</span>
        <form className="search-form" role="search" onSubmit={onSearch}>
          <input
            name="q"
            type="search"
            placeholder="z. B. Hamburg, Köln, Leipzig …"
            autoComplete="off"
            aria-label="Deutsche Stadt suchen"
            disabled={searching}
          />
          <button type="submit" disabled={searching}>
            Los
          </button>
        </form>
        {searchStatus?.msg ? (
          <p className={`search-status${searchStatus.error ? ' is-error' : ''}`} role="status">
            {searchStatus.msg}
          </p>
        ) : null}
      </section>

      {hasVoi && (
        <section className="sliders">
          <span className="section-label">Value Opportunity</span>
          <label className="cat-toggle voi-toggle">
            <input
              type="checkbox"
              checked={showHiddenGems}
              onChange={(e) => setShowHiddenGems(e.target.checked)}
            />
            Show value opportunities
          </label>
          {showHiddenGems ? (
            <div className="voi-legend" aria-hidden="true">
              <span className="voi-gem">Hidden Gem</span>
              <span className="voi-good">Good Value</span>
              <span className="voi-over">Overpriced</span>
            </div>
          ) : null}
          <p className="section-hint">
            Borders only — fill stays Infrastruktur. Best quality of life for the money.
          </p>
        </section>
      )}

      {hasRent && (
        <section className="sliders">
          <span className="section-label">Optional: Budget-Filter</span>
          <p className="section-hint">Dimmt Gebiete über dem Budget — ändert den Infrastruktur-Score nicht.</p>
          <div className="rent-budget">
            <label className="budget-field">
              <span>Wohnfläche (m²)</span>
              <input
                type="number"
                min={20}
                max={250}
                step={5}
                value={desiredAreaM2}
                onChange={(e) => setDesiredAreaM2(Math.max(20, Number(e.target.value) || 60))}
              />
            </label>
            <label className="budget-field">
              <span>Max. Warmmiete (€/Monat)</span>
              <input
                type="number"
                min={0}
                step={50}
                placeholder="z. B. 1500"
                value={maxMonthlyBudget ?? ''}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMaxMonthlyBudget(v > 0 ? v : null);
                }}
              />
            </label>
          </div>
        </section>
      )}

      <section className="legend">
        <span className="section-label">Infrastruktur</span>
        <label className="map-view-field">
          <span>Kartenansicht</span>
          <select
            value="objective"
            onChange={(e) => setMapView(e.target.value)}
            aria-label="Kartenansicht wählen"
          >
            {mapViewOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="legend-bar" id="legend-bar" />
        <div className="legend-scale">
          <span>0 Poor</span>
          <span>100 Excellent</span>
        </div>
        <p className="section-hint legend-note">{legendNote}</p>
      </section>

      <footer className="panel-foot">
        <span>
          {meta.count ?? features.length} Hexagone · H3 res {meta.h3_res ?? '?'}
        </span>
        <nav>
          <a href="/legal/impressum.html">Impressum</a> ·{' '}
          <a href="/legal/datenschutz.html">Datenschutz</a>
        </nav>
        <p className="attribution">
          Daten ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
            OpenStreetMap
          </a>
        </p>
        <p className="disclaimer">Informativ, keine Rechts-/Immobilienberatung.</p>
      </footer>
    </aside>
  );
}
