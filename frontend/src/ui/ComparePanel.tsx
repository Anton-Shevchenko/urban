import { ramp } from '../scoring/color';
import { PILLAR_LABELS } from '../scoring/engine';
import type { WohnIndexState, CompareItem } from '../hooks/useWohnIndex';

type Props = { state: WohnIndexState };

function computeCard(item: CompareItem, engine: WohnIndexState['engine']) {
  const result = engine.livingScore
    ? engine.livingScore(item.props)
    : { score: engine.comfortScalar(item.props) ?? 50, pillars: {} as Record<string, number> };
  const comfort = result.score;
  const size = Number(item.sizeM2);
  const price = Number(item.pricePerM2);
  const total = Number.isFinite(size) && size > 0 && Number.isFinite(price) && price > 0 ? size * price : null;
  const ratio = Number.isFinite(price) && price > 0 ? comfort / price : null;
  const [r, g, b] = ramp(comfort);
  return { comfort, total, ratio, color: `rgb(${r},${g},${b})`, pillars: result.pillars };
}

const euro = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 0 }) + ' €';

export function ComparePanel({ state }: Props) {
  const { comparison, setComparison, engine } = state;
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
        <p className="compare-hint">15-Minuten-Living-Score — vergleichbar zwischen Städten.</p>
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
                <span>Living Score</span>
                <b>{m.comfort.toFixed(0)}</b>
              </div>
              <table className="cc-factors">
                <tbody>
                  {(Object.keys(PILLAR_LABELS) as (keyof typeof PILLAR_LABELS)[]).map((key) => (
                    <tr key={key}>
                      <td>{PILLAR_LABELS[key]}</td>
                      <td>–</td>
                      <td>{(m.pillars[key] ?? 0).toFixed(0)}</td>
                    </tr>
                  ))}
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
