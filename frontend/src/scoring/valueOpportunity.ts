/**
 * Value Opportunity Index v1.2 — client helpers.
 * Pipeline computes scores; this formats tooltips / border levels.
 *
 * highlight: 2=hidden_gem, 1=good_value, 3=overpriced, 0=normal
 * gem_strength drives border thickness for gems / good value.
 */

export type VoiClass = 'hidden_gem' | 'good_value' | 'overpriced' | 'normal' | 'none' | string;

export function voiHighlightLevel(p: Record<string, unknown>): 0 | 1 | 2 | 3 {
  const h = Number(p.voi_highlight);
  if (h === 1 || h === 2 || h === 3) return h as 1 | 2 | 3;
  const cls = String(p.voi_class || 'normal');
  if (cls === 'hidden_gem') return 2;
  if (cls === 'good_value') return 1;
  if (cls === 'overpriced') return 3;
  return 0;
}

/** MapLibre line width from gem_strength (70–100 bands). */
export function voiBorderWidth(p: Record<string, unknown>): number {
  const level = voiHighlightLevel(p);
  if (level === 0) return 0;
  if (level === 3) return 2.4;
  const strength = Number(p.voi_gem_strength);
  if (!Number.isFinite(strength)) {
    return level === 2 ? 3.2 : 1.4;
  }
  if (strength >= 90) return 3.6;
  if (strength >= 80) return 2.6;
  if (strength >= 70) return 1.8;
  return level === 2 ? 1.6 : 1.2;
}

export type VoiTooltipRow = { label: string; value: string };

export type VoiTooltipModel = {
  title: string;
  overpriced: boolean;
  rows: VoiTooltipRow[];
  head: string;
  why: string[];
  trade: string[];
  tradeLabel: string;
};

function parseVoiExplain(explain: string, level: 1 | 2 | 3): {
  head: string;
  why: string[];
  trade: string[];
  tradeLabel: string;
} {
  const tradeLabel = level === 3 ? 'Negative:' : 'Trade-offs:';
  if (!explain) return { head: '', why: [], trade: [], tradeLabel };
  const lines = explain.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines[0] && !lines[0].startsWith('+') && !lines[0].startsWith('-')
    && !/^reasons:?$/i.test(lines[0]) && !/^why:?$/i.test(lines[0])
    && !/^trade-?offs?:?$/i.test(lines[0]) && !/^negative:?$/i.test(lines[0])
    ? lines[0]
    : '';
  const why: string[] = [];
  const trade: string[] = [];
  let mode: 'why' | 'trade' = 'why';
  for (const line of lines.slice(head ? 1 : 0)) {
    if (/^(reasons|why):?$/i.test(line)) { mode = 'why'; continue; }
    if (/^(trade-?offs?|negative):?$/i.test(line)) { mode = 'trade'; continue; }
    if (line.startsWith('+')) {
      mode = 'why';
      why.push(line);
    } else if (line.startsWith('-')) {
      mode = 'trade';
      trade.push(line);
    } else if (mode === 'why') {
      why.push(line);
    } else {
      trade.push(line);
    }
  }
  return { head, why, trade, tradeLabel };
}

export function voiTooltipModel(p: Record<string, unknown>): VoiTooltipModel | null {
  const level = voiHighlightLevel(p);
  if (level === 0) return null;

  const title =
    level === 2 ? 'Hidden Gem ⭐'
      : level === 1 ? 'Good Value'
        : 'Overpriced';

  const living = Number(p.s_living);
  const opp = Number(p.s_value_opportunity);
  const rent = Number(p.rent_eur_m2);
  const fairMin = Number(p.voi_fair_rent_min);
  const fairMax = Number(p.voi_fair_rent_max);
  const fairMed = Number(p.voi_fair_rent_median ?? p.voi_expected_rent_eur_m2);
  const gap = Number(p.voi_adjusted_price_gap ?? p.voi_price_gap);
  const premium = Number(p.voi_location_premium);
  const conf = String(p.voi_confidence || '').trim();
  const strength = Number(p.voi_gem_strength);
  const explain = String(p.voi_explain || '').trim();

  const rows: VoiTooltipRow[] = [];
  if (Number.isFinite(living)) {
    rows.push({ label: 'Infrastruktur', value: `${Math.round(living)}/100` });
  }
  if (Number.isFinite(opp)) {
    rows.push({ label: 'Value Opportunity', value: `${Math.round(opp)}/100` });
  }
  if (Number.isFinite(rent)) {
    rows.push({ label: 'Rent', value: `${rent.toFixed(0)} €/m²` });
  }
  if (Number.isFinite(fairMin) && Number.isFinite(fairMax)) {
    rows.push({ label: 'Fair rent', value: `${fairMin.toFixed(0)}–${fairMax.toFixed(0)} €/m²` });
  } else if (Number.isFinite(fairMed)) {
    rows.push({ label: 'Fair rent', value: `${fairMed.toFixed(0)} €/m²` });
  }
  if (Number.isFinite(gap)) {
    const pct = Math.round(gap * 100);
    const value = pct >= 0
      ? `−${pct}% (below fair rent)`
      : `+${Math.abs(pct)}% (above fair rent)`;
    rows.push({ label: 'Price advantage', value });
  }
  if (Number.isFinite(premium) && (level === 3 || premium >= 60)) {
    rows.push({ label: 'Location premium', value: `${Math.round(premium)}/100` });
  }
  if (Number.isFinite(strength) && level === 2) {
    rows.push({ label: 'Gem strength', value: `${Math.round(strength)}/100` });
  }
  if (conf) {
    rows.push({ label: 'Confidence', value: conf });
  }

  return {
    title,
    overpriced: level === 3,
    rows,
    ...parseVoiExplain(explain, level),
  };
}
