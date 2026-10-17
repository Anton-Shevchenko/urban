import { CYCLEWAY_LEGEND } from './cyclewayStyle';

type Props = {
  enabled: readonly string[];
  onToggle: (kind: string) => void;
};

export function CyclewayLegend({ enabled, onToggle }: Props) {
  const on = new Set(enabled);
  return (
    <fieldset className="cycle-legend" id="cycleway-legend">
      <legend>Radwege</legend>
      {CYCLEWAY_LEGEND.map((entry) => {
        const checked = on.has(entry.kind);
        return (
          <label
            key={entry.kind}
            className={checked ? undefined : 'is-off'}
            data-kind={entry.kind}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggle(entry.kind)}
            />
            <span
              className={`cycle-swatch${entry.dashed ? ' is-dashed' : ''}`}
              style={{ ['--swatch' as string]: entry.color }}
            />
            <span>{entry.label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
