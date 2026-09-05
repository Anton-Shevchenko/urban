import type { HexTooltipModel } from './hexTooltipModel';
import type { VoiTooltipModel } from '../scoring/valueOpportunity';

export type { HexTooltipModel } from './hexTooltipModel';

function barChars(score: number): string {
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function VoiBlock({ voi }: { voi: VoiTooltipModel }) {
  return (
    <div className="tt-voi">
      <div className={voi.overpriced ? 'tt-voi-over' : 'tt-pass'}>
        <b>{voi.title}</b>
      </div>
      <table className="tt-breakdown">
        <tbody>
          {voi.rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td><b>{row.value}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
      {voi.head ? <div className="tt-fail-msg">{voi.head}</div> : null}
      {voi.why.length > 0 ? (
        <div className="tt-voi-explain">
          <div><b>Why:</b></div>
          {voi.why.map((line) => <div key={line}>{line}</div>)}
        </div>
      ) : null}
      {voi.trade.length > 0 ? (
        <div className="tt-voi-explain">
          <div><b>{voi.tradeLabel}</b></div>
          {voi.trade.map((line) => <div key={line}>{line}</div>)}
        </div>
      ) : null}
    </div>
  );
}

export function HexTooltip({ model }: { model: HexTooltipModel }) {
  return (
    <div
      id="tooltip"
      className="tooltip"
      style={{ left: model.x, top: model.y }}
    >
      {model.insufficient ? (
        <div className="tt-score">
          <div className="tt-pass"><b>Insufficient data</b></div>
          <div className="tt-fail-msg">
            Data confidence: {model.confidence}%
            {model.missingData.length ? ` · missing: ${model.missingData.join(', ')}` : ''}
          </div>
        </div>
      ) : (
        <>
          <div className="tt-score">
            {model.voi ? <VoiBlock voi={model.voi} /> : null}
            <div className="tt-pass">
              <b>{model.objective}/100</b> Infrastruktur · mode: {model.modeLabel}
            </div>
            <div className="tt-fail-msg">
              Your Match: {model.match}/100 · City percentile: {model.percentile} · Data confidence: {model.confidence}%
            </div>
            <div className="tt-fail-msg">{model.explainText}</div>
          </div>
          <table className="tt-breakdown">
            <thead>
              <tr>
                <td>Metrik</td>
                <td />
                <td />
              </tr>
            </thead>
            <tbody>
              {model.pillars.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td className="tt-bar">{barChars(row.score)}</td>
                  <td>{row.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
