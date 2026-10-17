import { useContext, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Feature } from 'geojson';
import { ramp } from '../scoring/color';
import {
  buildHexInfoModel,
  formatAmenityPresence,
  mergeCityHexProps,
  type HexInfoModel,
} from '../map/hexInfoModel';
import type { ScoringEngine } from '../scoring/types';
import { ChatContext, CityDataContext, PaintContext } from '../wohnindex/contexts';
import { COMPARE_AI_PROMPT, MAX_COMPARE, chatHexFromItem } from '../wohnindex/compareSnapshot';
import { useCompare } from '../wohnindex';
import type { CompareItem } from '../wohnindex';
import { HexInfoModal } from './HexInfoModal';

function factsForItem(
  item: CompareItem,
  engine: ScoringEngine | null,
  cityFeatures: Feature[] | undefined,
): HexInfoModel {
  const props = mergeCityHexProps(item.props, cityFeatures);
  return buildHexInfoModel(props, item.cityName, {
    engine,
    cityPercentile: item.cityPercentile ?? null,
  });
}

function computeCard(info: HexInfoModel, item: CompareItem) {
  const comfort = info.comfort;
  const size = Number(item.sizeM2);
  const price = Number(item.pricePerM2);
  const total = Number.isFinite(size) && size > 0 && Number.isFinite(price) && price > 0 ? size * price : null;
  const ratio = comfort != null && Number.isFinite(price) && price > 0 ? comfort / price : null;
  const [r, g, b] = ramp(comfort ?? 0);
  return {
    comfort,
    percentile: info.percentile,
    confidence: info.confidence,
    total,
    ratio,
    color: comfort == null ? '#BDBDBD' : `rgb(${r},${g},${b})`,
    info,
  };
}

function bestIndex(values: Array<number | null>, preferHigh: boolean): number | null {
  let best: number | null = null;
  let idx: number | null = null;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    if (best == null || (preferHigh ? v > best : v < best)) {
      best = v;
      idx = i;
    }
  });
  return idx;
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

  const cards = comparison.map((item) => {
    const features = city?.citySlug === item.citySlug ? city.features : undefined;
    const info = factsForItem(item, engine, features);
    return { item, m: computeCard(info, item), info };
  });
  let bestId: string | null = null;
  let bestRatio = -Infinity;
  cards.forEach(({ item, m }) => {
    if (m.ratio != null && m.ratio > bestRatio) {
      bestRatio = m.ratio;
      bestId = item.id;
    }
  });
  const cityCount = new Set(comparison.map((i) => i.citySlug || i.cityName)).size;
  const showGrid = cards.length >= 2;
  const pillarBest = showGrid
    ? cards[0].info.pillars.map((_, row) =>
        bestIndex(
          cards.map((c) => c.info.pillars[row]?.score ?? null),
          true,
        ),
      )
    : [];
  const amenityBest = showGrid
    ? cards[0].info.walks.map((_, row) =>
        bestIndex(
          cards.map((c) => {
            const w = c.info.walks[row];
            if (!w) return null;
            if (w.inHex != null && w.inHex > 0) return 0;
            if (w.minutes != null && w.minutes < 1) return 0;
            return w.minutes;
          }),
          false,
        ),
      )
    : [];

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
    const features = city?.citySlug === first.citySlug ? city.features : undefined;
    const next = chatHexFromItem({ ...first, props: mergeCityHexProps(first.props, features) });
    requestChatPrompt(COMPARE_AI_PROMPT);
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
      className={variant === 'home' ? 'is-home' : showGrid ? 'is-grid' : undefined}
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
      <div className="compare-scroll">
      <p className="compare-hint">
        Klick merkt ein Hexagon. Die Tabelle vergleicht Säulen und Angebot. Bis zu {MAX_COMPARE},
        auch aus verschiedenen Städten.
      </p>
      {showGrid && variant === 'home' ? (
        <div className="compare-grid-wrap">
          <table className="compare-grid">
            <thead>
              <tr>
                <th> </th>
                {cards.map(({ item }) => (
                  <th key={item.id}>
                    {item.cityName}
                    <span>#{String(item.h3).slice(-6)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cards[0].info.pillars.map((row, rowIdx) => (
                <tr key={row.key}>
                  <th>{row.label}</th>
                  {cards.map((c, col) => {
                    const score = c.info.pillars[rowIdx]?.score;
                    return (
                      <td
                        key={c.item.id}
                        className={pillarBest[rowIdx] === col ? 'is-best' : undefined}
                      >
                        {score == null ? '—' : Math.round(score)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {cards[0].info.walks.map((row, rowIdx) => (
                <tr key={row.key}>
                  <th>{row.label}</th>
                  {cards.map((c, col) => (
                    <td
                      key={c.item.id}
                      className={amenityBest[rowIdx] === col ? 'is-best' : undefined}
                    >
                      {formatAmenityPresence(c.info.walks[rowIdx] ?? row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
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
