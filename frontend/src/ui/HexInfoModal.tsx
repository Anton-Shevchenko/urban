import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { buildHexInfoModel, formatAmenityPresence, mergeCityHexProps } from '../map/hexInfoModel';
import type { Feature } from 'geojson';
import type { ScoringEngine } from '../scoring/types';

type Props = {
  cityName: string;
  props: Record<string, unknown>;
  cityFeatures?: Feature[];
  engine?: ScoringEngine | null;
  cityPercentile?: number | null;
  onClose: () => void;
};

export function HexInfoModal({
  cityName,
  props,
  cityFeatures,
  engine,
  cityPercentile,
  onClose,
}: Props) {
  const info = buildHexInfoModel(mergeCityHexProps(props, cityFeatures), cityName, {
    engine,
    cityPercentile,
  });
  const h3Short = info.h3 ? `#${info.h3.slice(-6)}` : '';

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="hex-info-overlay" onClick={onClose} role="presentation">
      <div
        className="hex-info-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hex-info-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="hex-info-head">
          <div>
            <h2 id="hex-info-title">Hexagon-Info</h2>
            <p>
              {cityName}
              {h3Short ? ` · ${h3Short}` : ''}
            </p>
          </div>
          <button type="button" className="hex-info-close" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </header>
        {info.insufficient ? (
          <p className="hex-info-note">Unzureichende Daten für die Infrastruktur.</p>
        ) : (
          <>
            <p className="hex-info-score">
              <b>{info.comfort == null ? '—' : Math.round(info.comfort)}</b>
              <span>/100 Infrastruktur</span>
            </p>
            <p className="hex-info-note">{info.explainText}</p>
            <p className="hex-info-meta">
              Your Match: {info.match == null ? '—' : Math.round(info.match)}
              {' · '}
              Perzentil: {info.percentile == null ? '—' : Math.round(info.percentile)}
              {' · '}
              Konfidenz:{' '}
              {info.confidence == null ? '—' : `${Math.round(info.confidence * 100)}%`}
            </p>
            {info.priceLines.map((line) => (
              <p className="hex-info-meta" key={line}>
                {line}
              </p>
            ))}
            <table className="hex-info-table">
              <thead>
                <tr>
                  <th>Säule</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {info.pillars.map((row) => (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    <td>{row.score == null ? '—' : Math.round(row.score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="hex-info-table">
              <thead>
                <tr>
                  <th>Angebot</th>
                  <th>In diesem Hexagon</th>
                </tr>
              </thead>
              <tbody>
                {info.walks.map((row) => (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    <td>{formatAmenityPresence(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
