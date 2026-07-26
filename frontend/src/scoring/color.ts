/** RdYlGn-style diverging color ramp (0 = bad/red, 100 = good/green). */

const STOPS: [number, [number, number, number]][] = [
  [0, [165, 0, 38]],
  [25, [244, 109, 67]],
  [50, [254, 224, 139]],
  [75, [166, 217, 106]],
  [100, [26, 152, 80]],
];

function lerp(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

export function ramp(value: number): [number, number, number] {
  const v = Math.max(0, Math.min(100, value));
  for (let i = 1; i < STOPS.length; i++) {
    const [x0, c0] = STOPS[i - 1];
    const [x1, c1] = STOPS[i];
    if (v <= x1) {
      const t = (v - x0) / (x1 - x0);
      return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export function cssGradient(): string {
  return (
    'linear-gradient(90deg,' +
    STOPS.map(([x, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${x}%`).join(',') +
    ')'
  );
}

export function maplibreStops(domainMin = 0, domainMax = 100): (number | string)[] {
  const out: (number | string)[] = [];
  STOPS.forEach(([x, c]) => {
    out.push(domainMin + (domainMax - domainMin) * (x / 100));
    out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
  });
  return out;
}
