import { useMemo } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { METRIC_MODE_LABELS, PRESET_LABELS, PROFILE_IDS } from '../scoring/constants';
import { LIVING_WEIGHTS, PILLAR_KEYS, PILLAR_LABELS } from '../scoring/engine';
import type { WohnIndexState } from '../hooks/useWohnIndex';

type Props = {
  state: WohnIndexState;
  onClose: () => void;
};

export function ControlPanel({ state, onClose }: Props) {
  const {
    cityName,
    meta,
    desiredAreaM2,
    setDesiredAreaM2,
    maxMonthlyBudget,
    setMaxMonthlyBudget,
    mapView,
    setMapView,
    mapViewOptions,
    showHiddenGems,
    setShowHiddenGems,
    searchStatus,
    searching,
    runSearch,
    applyPreset,
    setPillarWeightPercent,
    hasRent,
    weights,
    activeProfile,
  } = state;

  const hasVoi = Boolean(
    (meta as { has_value_opportunity?: boolean }).has_value_opportunity
    || state.features.some((f) => {
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

  /** Live renormalised % from UI weights (updates while dragging). */
  const pillarWeights = useMemo(() => {
    const raw: Record<string, number> = {};
    let sum = 0;
    PILLAR_KEYS.forEach((k) => {
      const v = Number(weights[k]);
      // 0 is a valid weight (metric off); only default when unset.
      const w = Number.isFinite(v) && v >= 0 ? v : ((LIVING_WEIGHTS as Record<string, number>)[k] ?? 0);
      raw[k] = w;
      sum += w;
    });
    if (sum <= 0) return { ...LIVING_WEIGHTS };
    const out: Record<string, number> = {};
    PILLAR_KEYS.forEach((k) => { out[k] = raw[k] / sum; });
    return out;
  }, [weights]);

  const legendNote = useMemo(() => {
    if (mapView === 'personal_match') {
      const profileLabel = PRESET_LABELS[activeProfile] || activeProfile;
      return `Your Match · Profil „${profileLabel}“ · absolute 0–100 · ändert nicht den Living Score`;
    }
    if (mapView === 'city_percentile') {
      return 'City percentile · Anteil besserer Punkte in dieser Stadt (nicht absolute Qualität)';
    }
    if (mapView && mapView !== 'objective' && mapView !== 'comfort' && mapView !== 'living') {
      const key = mapView.replace(/^pillar:/, '');
      const label = state.FACTOR_LABELS[key] ?? METRIC_MODE_LABELS[mapView] ?? key;
      return `${label} · absolute 0–100`;
    }
    return 'Living Score · absolute Qualität der Lage · vergleichbar zwischen Städten · 85–100 Excellent · 70–84 Good · 55–69 Average · 40–54 Below average · 0–39 Poor · grau = Insufficient data';
  }, [mapView, state.FACTOR_LABELS, state.paintVersion, activeProfile]);

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
            Living Score (objektiv) · Your Match (Profil) · 0–100
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

      <section className="presets">
        <span className="section-label">Your Match · Profil</span>
        <div className="preset-row">
          {PROFILE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`preset${activeProfile === id ? ' is-active' : ''}`}
              aria-pressed={activeProfile === id}
              onClick={() => applyPreset(id)}
            >
              {PRESET_LABELS[id] || id}
            </button>
          ))}
        </div>
        {activeProfile === 'custom' ? (
          <p className="section-hint">Eigene Gewichte für Your Match — Living Score bleibt unverändert.</p>
        ) : (
          <p className="section-hint">
            Profile beeinflussen nur Your Match, nicht den objektiven Living Score.
          </p>
        )}
      </section>

      <section className="sliders sliders-positive">
        <span className="section-label">Your Match · Gewichte</span>
        <p className="section-hint">Summe immer 100% — steuert Your Match; Karte „Living Score“ bleibt objektiv.</p>
        {PILLAR_KEYS.map((key) => {
          const pct = Math.round((pillarWeights[key] ?? 0) * 100);
          return (
            <label key={key} className="slider">
              <div className="slider-top">
                <span>{PILLAR_LABELS[key as keyof typeof PILLAR_LABELS] || key}</span>
                <b className="slider-value">{pct}%</b>
              </div>
              <div className="slider-track-wrap">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={pct}
                  style={{ '--fill': `${pct}%` } as CSSProperties}
                  aria-label={`${PILLAR_LABELS[key as keyof typeof PILLAR_LABELS] || key} Gewicht`}
                  onChange={(e) => setPillarWeightPercent(key, Number(e.target.value))}
                />
              </div>
            </label>
          );
        })}
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
            Borders only — fill stays Living Score. Best quality of life for the money.
          </p>
        </section>
      )}

      {hasRent && (
        <section className="sliders">
          <span className="section-label">Optional: Budget-Filter</span>
          <p className="section-hint">Dimmt Gebiete über dem Budget — ändert den Living Score nicht grundlegend.</p>
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
        <span className="section-label">
          {mapView === 'personal_match'
            ? 'Your Match'
            : mapView === 'city_percentile'
              ? 'City percentile'
              : 'Living Score'}
        </span>
        <label className="map-view-field">
          <span>Kartenansicht</span>
          <select
            value={mapView === 'comfort' || mapView === 'living' ? 'objective' : mapView}
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
          <span>{mapView === 'city_percentile' ? '0 niedriger' : '0 Poor'}</span>
          <span>{mapView === 'city_percentile' ? '100 höher in Stadt' : '100 Excellent'}</span>
        </div>
        <p className="section-hint legend-note">{legendNote}</p>
      </section>

      <footer className="panel-foot">
        <span>
          {meta.count ?? state.features.length} Hexagone · H3 res {meta.h3_res ?? '?'}
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
          , Zensus 2022, GTFS (Mobilithek).
        </p>
        <p className="disclaimer">Informativ, keine Rechts-/Immobilienberatung.</p>
      </footer>
    </aside>
  );
}
