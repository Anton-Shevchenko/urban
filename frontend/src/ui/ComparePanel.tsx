import { useContext, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ramp } from '../scoring/color';
import { PILLAR_KEYS, PILLAR_LABELS } from '../scoring/engine';
import { locationScore } from '../scoring/locationScore';
import type { PipelinePoint, ScoringEngine } from '../scoring/types';
import { ChatContext, CityDataContext, PaintContext } from '../wohnindex/contexts';
import { COMPARE_AI_PROMPT, MAX_COMPARE, chatHexFromItem } from '../wohnindex/compareSnapshot';
import { useCompare } from '../wohnindex';
import type { CompareItem } from '../wohnindex';
import { HexInfoModal } from './HexInfoModal';

function computeCard(item: CompareItem, engine: ScoringEngine | null) {
  const result = locationScore(
    item.props as PipelinePoint,
    engine
      ? {
          pillarWeights: engine.getPillarWeights(),
          groupMultipliers: engine.getGroupMultipliers(),
          affordabilityFocus: engine.getAffordabilityFocus?.() ?? 0,
          cityPercentile: item.cityPercentile ?? null,
        }
      : { cityPercentile: item.cityPercentile ?? null },
  );
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

type Props = {
  variant?: 'map' | 'home';
};

export function ComparePanel({ variant = 'map' }: Props) {
  const { comparison, setComparison, requestFocus, requestChatPrompt } = useCompare();
  const paint = useContext(PaintContext);
  const city = useContext(CityDataContext);
  const chat = useContext(ChatContext);
  const navigate = useNavigate();
  const engine = paint?.engine ?? null;
  const [infoItem, setInfoItem] = useState<CompareItem | null>(null);
  const cards = comparison.map((item) => ({ item, m: computeCard(item, engine) }));
  let bestId: string | null = null;
  let bestRatio = -Infinity;
  cards.forEach(({ item, m }) => {
    if (m.ratio != null && m.ratio > bestRatio) {
      bestRatio = m.ratio;
      bestId = item.id;
    }
  });
  const cityCount = new Set(comparison.map((i) => i.citySlug || i.cityName)).size;

  function openOnMap(item: CompareItem) {
    if (!item.citySlug) return;
    requestFocus(item);
    if (city?.citySlug !== item.citySlug) {
      navigate(`/city/${encodeURIComponent(item.citySlug)}`);
    }
  }

  function askAI() {
    if (comparison.length < 2) return;
    const first = comparison.find((item) => item.citySlug && item.h3);
    if (!first) return;
    requestChatPrompt(COMPARE_AI_PROMPT);
    const next = chatHexFromItem(first);
    if (chat && next) {
      chat.setChatHex(next);
      chat.setChatOpen(true);
    }
    requestFocus(first);
    if (city?.citySlug !== first.citySlug) {
      navigate(`/city/${encodeURIComponent(first.citySlug)}`);
    }
  }

  if (comparison.length === 0) return null;

  return (
    <aside
      id="compare-panel"
      className={variant === 'home' ? 'is-home' : undefined}
      aria-label="Gemerkte Orte"
    >
      <header className="compare-head">
        <h2>
          Merkliste
          {cityCount > 1 ? <span className="compare-cities">{cityCount} Städte</span> : null}
        </h2>
        <div className="compare-actions">
          {comparison.length >= 2 ? (
            <button type="button" className="compare-ai" onClick={askAI}>
              Mit KI vergleichen
            </button>
          ) : null}
          <button type="button" id="compare-clear" onClick={() => setComparison([])}>
            Alle löschen
          </button>
        </div>
      </header>
      <p className="compare-hint">
        Klick auf ein Hexagon merkt es. × nimmt es runter. Bis zu {MAX_COMPARE}, auch aus
        verschiedenen Städten — dann mit KI vergleichen.
      </p>
      <div className="compare-list">
        {cards.map(({ item, m }) => (
          <div key={item.id} className={`compare-card${item.id === bestId ? ' is-best' : ''}`}>
            <div className="cc-head">
              <div className="cc-title">
                {item.citySlug ? (
                  <button type="button" className="cc-open" onClick={() => openOnMap(item)}>
                    <b>{item.cityName}</b>
                    <span className="cc-h3">#{String(item.h3).slice(-6)}</span>
                  </button>
                ) : (
                  <>
                    <b>{item.cityName}</b>
                    <span className="cc-h3">#{String(item.h3).slice(-6)}</span>
                  </>
                )}
              </div>
              <div className="cc-actions">
                <button
                  type="button"
                  className="hex-info-btn"
                  onClick={() => setInfoItem(item)}
                  aria-label="Hexagon-Info"
                  title="Hexagon-Info"
                >
                  Info
                </button>
                <button
                  type="button"
                  className="cc-remove"
                  onClick={() => setComparison(comparison.filter((i) => i.id !== item.id))}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="cc-badge" style={{ background: m.color }}>
              <span>Infrastruktur</span>
              <b>{m.comfort == null ? '—' : m.comfort.toFixed(0)}</b>
            </div>
            <p className="section-hint">
              {m.percentile == null
                ? 'Perzentil: —'
                : `Perzentil in ${item.cityName}: ${Math.round(m.percentile)}`}
              {' · '}
              Konfidenz: {m.confidence == null ? '—' : `${Math.round(m.confidence * 100)}%`}
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
                        c.id === item.id
                          ? { ...c, pricePerM2: Number.isFinite(pricePerM2) ? pricePerM2 : null }
                          : c,
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
            {item.citySlug && city?.citySlug !== item.citySlug ? (
              <button type="button" className="cc-goto" onClick={() => openOnMap(item)}>
                Karte öffnen
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {infoItem ? (
        <HexInfoModal
          cityName={infoItem.cityName}
          props={infoItem.props}
          cityFeatures={city?.citySlug === infoItem.citySlug ? city.features : undefined}
          engine={engine}
          cityPercentile={infoItem.cityPercentile}
          onClose={() => setInfoItem(null)}
        />
      ) : null}
    </aside>
  );
}
