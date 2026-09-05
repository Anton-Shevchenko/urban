import { ramp } from '../scoring/color';
import { PILLAR_KEYS, PILLAR_LABELS } from '../scoring/engine';
import type { ScoringEngine } from '../scoring/types';
import { useCompare, usePaint } from '../wohnindex';
import type { CompareItem } from '../wohnindex';

function computeCard(item: CompareItem, engine: ScoringEngine) {
  const result = engine.locationScore
    ? engine.locationScore(item.props)
    : engine.livingScore
      ? engine.livingScore(item.props)
      : {
          score: engine.comfortScalar(item.props),
          objectiveScore: engine.comfortScalar(item.props),
          personalMatchScore: null,
          cityPercentile: null,
          confidence: 0,
          pillars: {} as Record<string, number | null>,
        };
  const comfort = result.objectiveScore ?? result.score;
  const size = Number(item.sizeM2);
  const price = Number(item.pricePerM2);
  const total = Number.isFinite(size) && size > 0 && Number.isFinite(price) && price > 0 ? size * price : null;
  const ratio = comfort != null && Number.isFinite(price) && price > 0 ? comfort / price : null;
  const [r, g, b] = ramp(comfort ?? 0);
  return {
    comfort,
    match: result.personalMatchScore ?? null,
    percentile: result.cityPercentile ?? null,
    confidence: result.confidence ?? null,
    total,
    ratio,
    color: comfort == null ? '#BDBDBD' : `rgb(${r},${g},${b})`,
    pillars: result.pillars,
  };
}

const euro = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 0 }) + ' €';

export function ComparePanel() {
  const { comparison, setComparison } = useCompare();
  const { engine } = usePaint();
  const cards = comparison.map((item) => ({ item, m: computeCard(item, engine) }));
  let bestId: string | null = null;
  let bestRatio = -Infinity;
  cards.forEach(({ item, m }) => {
    if (m.ratio != null && m.ratio > bestRatio) {
      bestRatio = m.ratio;
      bestId = item.id;
    }
  });

  return (
    <>
      <aside id="compare-panel" aria-label="Wohnungen vergleichen" hidden={comparison.length === 0}>
        <header className="compare-head">
          <h2>Wohnungen vergleichen</h2>
          <button type="button" id="compare-clear" onClick={() => setComparison([])}>
            Alle löschen
          </button>
        </header>
        <p className="compare-hint">Infrastruktur-Score — Läden, Cafés, Ärzte, Schulen in Gehweite.</p>
        <div className="compare-list">
          {cards.map(({ item, m }) => (
            <div key={item.id} className={`compare-card${item.id === bestId ? ' is-best' : ''}`}>
              <div className="cc-head">
                <div className="cc-title">
                  <b>{item.cityName}</b>
                  <span className="cc-h3">#{String(item.h3).slice(-6)}</span>
                </div>
                <button
                  type="button"
                  className="cc-remove"
                  onClick={() => setComparison(comparison.filter((i) => i.id !== item.id))}
                >
                  ×
                </button>
              </div>
              <div className="cc-badge" style={{ background: m.color }}>
                <span>Infrastruktur</span>
                <b>{m.comfort == null ? '—' : m.comfort.toFixed(0)}</b>
              </div>
              <p className="section-hint">
                Your Match: {m.match == null ? '—' : Math.round(m.match)}
                {' · '}City percentile: {m.percentile == null ? '—' : Math.round(m.percentile)}
                {' · '}Confidence: {m.confidence == null ? '—' : `${Math.round(m.confidence * 100)}%`}
              </p>
              <table className="cc-factors">
                <tbody>
                  {PILLAR_KEYS.map((key) => {
                      const pillars = m.pillars as Record<string, number | null | undefined>;
                      const val = pillars[key];
                      const label = PILLAR_LABELS[key] || key;
                      return (
                    <tr key={key}>
                      <td>{label}</td>
                      <td>–</td>
                      <td>{val == null ? '—' : Number(val).toFixed(0)}</td>
                    </tr>
                      );
                  })}
                </tbody>
              </table>
              <div className="cc-inputs">
                <label>
                  m²
                  <input
                    type="number"
                    value={item.sizeM2 ?? ''}
                    onChange={(e) => {
                      const sizeM2 = Number(e.target.value);
                      setComparison(
                        comparison.map((c) => (c.id === item.id ? { ...c, sizeM2 } : c)),
                      );
                    }}
                  />
                </label>
                <label>
                  €/m²
                  <input
                    type="number"
                    step="0.1"
                    value={item.pricePerM2 ?? ''}
                    onChange={(e) => {
                      const pricePerM2 = Number(e.target.value);
                      setComparison(
                        comparison.map((c) =>
                          c.id === item.id ? { ...c, pricePerM2: Number.isFinite(pricePerM2) ? pricePerM2 : null } : c,
                        ),
                      );
                    }}
                  />
                </label>
              </div>
              <div className="cc-meta">
                {m.total != null ? <span>≈ {euro(m.total)}/Monat</span> : null}
                {m.ratio != null ? <span>Score/€: {m.ratio.toFixed(2)}</span> : null}
                {item.id === bestId ? <span className="cc-best">Beste Preis/Score</span> : null}
              </div>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
