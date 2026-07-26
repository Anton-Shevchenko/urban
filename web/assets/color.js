/* RdYlGn-style diverging color ramp (0 = bad/red, 100 = good/green).
   No external dependency; simple piecewise-linear RGB interpolation. */
(function (global) {
  const STOPS = [
    [0,   [165, 0, 38]],   // dark red
    [25,  [244, 109, 67]], // orange
    [50,  [254, 224, 139]],// yellow
    [75,  [166, 217, 106]],// light green
    [100, [26, 152, 80]],  // green
  ];

  function lerp(a, b, t) {
    return Math.round(a + (b - a) * t);
  }

  // value in [0,100] -> [r,g,b]
  function ramp(value) {
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

  function cssGradient() {
    return (
      'linear-gradient(90deg,' +
      STOPS.map(([x, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${x}%`).join(',') +
      ')'
    );
  }

  // Flatten stops for a MapLibre ["interpolate", ...] expression over [0,100].
  // domainMin/domainMax remap the 0..100 palette onto an arbitrary value range.
  function maplibreStops(domainMin, domainMax) {
    const lo = domainMin == null ? 0 : domainMin;
    const hi = domainMax == null ? 100 : domainMax;
    const out = [];
    STOPS.forEach(([x, c]) => {
      out.push(lo + (hi - lo) * (x / 100));
      out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    });
    return out;
  }

  global.ColorRamp = { ramp, cssGradient, maplibreStops };
})(window);
