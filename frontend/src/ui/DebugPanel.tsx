import { useEffect, useMemo, useState } from 'react';
import { STEP_LABELS } from '../scoring/constants';
import type { ScoreDistribution } from '../scoring/histogram';
import { usePaint } from '../wohnindex';

function DistChart({ dist }: { dist: ScoreDistribution }) {
  const maxCount = Math.max(...dist.bins.map((b) => b.count), 1);
  return (
    <div className="debug-dist">
      <div className="debug-dist-summary">
        mean <b>{dist.mean.toFixed(1)}</b>
        {' · '}
        p50 <b>{dist.p50.toFixed(1)}</b>
        {' · '}
        {Math.round(dist.min)}–{Math.round(dist.max)}
        {' · '}
        ≥70 <b>{dist.ge70.toFixed(0)}%</b>
        {' · '}
        &lt;30 <b>{dist.lt30.toFixed(0)}%</b>
      </div>
      <div className="debug-hist" role="img" aria-label={`Histogramm ${dist.label}`}>
        {dist.bins.map((bin) => (
          <div key={bin.label} className="debug-hist-col" title={`${bin.label}: ${bin.count} (${bin.pct.toFixed(1)}%)`}>
            <div className="debug-hist-bar-wrap">
              <div
                className="debug-hist-bar"
                style={{ height: `${(100 * bin.count) / maxCount}%` }}
              />
            </div>
            <span className="debug-hist-label">{bin.lo}</span>
          </div>
        ))}
      </div>
      <div className="debug-hist-axis">
        <span>0</span>
        <span>Score →</span>
        <span>100</span>
      </div>
    </div>
  );
}

function MiniBars({ dist }: { dist: ScoreDistribution }) {
  const maxCount = Math.max(...dist.bins.map((b) => b.count), 1);
  return (
    <div className="debug-mini-hist" title={`${dist.label}: mean ${dist.mean.toFixed(1)}`}>
      {dist.bins.map((bin) => (
        <span
          key={bin.label}
          className="debug-mini-bar"
          style={{ height: `${Math.max(2, (100 * bin.count) / maxCount)}%` }}
        />
      ))}
    </div>
  );
}

export function DebugPanel() {
  const { debugReport: report, debugMode, painting } = usePaint();
  const [distKey, setDistKey] = useState<string>('comfort');

  useEffect(() => {
    if (!report?.distributions.length) return;
    const preferred = report.mapView === 'comfort' ? 'comfort' : report.mapView;
    if (report.distributions.some((d) => d.key === preferred)) {
      setDistKey(preferred);
      return;
    }
    setDistKey((prev) =>
      report.distributions.some((d) => d.key === prev)
        ? prev
        : report.distributions[0]!.key,
    );
  }, [report?.citySlug, report?.mapView]);

  const selectedDist = useMemo(() => {
    if (!report?.distributions.length) return null;
    return (
      report.distributions.find((d) => d.key === distKey) ?? report.distributions[0]!
    );
  }, [report, distKey]);

  if (!debugMode || !report) return null;

  return (
    <aside id="debug-panel" aria-label="Debug scoring">
      <header className="debug-head">
        <h2>Debug · Scoring</h2>
        <span className="debug-badge">?debug=true</span>
      </header>
      <p className="debug-meta">
        {report.cityName} · {report.hexCount} hex · pass{' '}
        <b>
          {report.passingCount}/{report.hexCount}
        </b>
        {report.paintStats ? (
          <>
            {' '}
            · paint <b>{report.paintStats.ms} ms</b> · color{' '}
            {Math.round(report.paintStats.lo)}–{Math.round(report.paintStats.hi)}
          </>
        ) : null}
      </p>

      {report.distributions?.length ? (
        <>
          <span className="section-label">Verteilung (Hexagone)</span>
          <label className="debug-dist-select">
            <span>Indikator</span>
            <select
              value={selectedDist?.key ?? 'comfort'}
              onChange={(e) => setDistKey(e.target.value)}
              aria-label="Indikator für Histogramm"
            >
              {report.distributions.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          {selectedDist ? <DistChart dist={selectedDist} /> : null}

          <div className="debug-dist-overview">
            {report.distributions.map((d) => (
              <button
                key={d.key}
                type="button"
                className={`debug-dist-chip${d.key === selectedDist?.key ? ' is-active' : ''}`}
                onClick={() => setDistKey(d.key)}
              >
                <span className="debug-dist-chip-label">{d.label}</span>
                <MiniBars dist={d} />
                <span className="debug-dist-chip-mean">{d.mean.toFixed(0)}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <span className="section-label">Aktive Kriterien</span>
      {!report.factorRows.length ? (
        <p className="section-hint is-warn">Keine aktiven Faktoren</p>
      ) : (
        <table className="debug-table">
          <thead>
            <tr>
              <th>Faktor</th>
              <th>Imp.</th>
              <th>≥ thr</th>
              <th>Ø score</th>
              <th>Pass %</th>
            </tr>
          </thead>
          <tbody>
            {report.factorRows.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td>{STEP_LABELS[row.importance] ?? row.importance}</td>
                <td>{row.threshold != null ? Math.round(row.threshold) : '–'}</td>
                <td>{row.meanScore.toFixed(1)}</td>
                <td>
                  {(row.passRate * 100).toFixed(1)}%
                  <span className="debug-muted">
                    {' '}
                    ({row.passCount}/{row.sampleCount})
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <span className="section-label">Gewichte (raw)</span>
      <pre className="debug-pre">{JSON.stringify(report.weights, null, 2)}</pre>

      <span className="section-label">Präferenzen</span>
      <pre className="debug-pre">
        {JSON.stringify(
          { include: report.prefInclude, targets: report.prefTargets, mapView: report.mapView },
          null,
          2,
        )}
      </pre>

      {painting ? <p className="section-hint">Karte wird neu berechnet …</p> : null}
    </aside>
  );
}
