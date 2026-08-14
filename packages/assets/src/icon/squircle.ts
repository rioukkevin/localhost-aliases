/**
 * The macOS app-icon silhouette.
 *
 * It is neither a circle nor a plain rounded rectangle — the corner is a *continuous*
 * curve that keeps flowing into the straight edge. A superellipse
 * |x/a|^n + |y/a|^n = 1 with n = 5 reproduces Apple's shape closely enough: on the
 * 824pt tile it puts the 45-degree point 358.7pt from the centre, which back-solves to a
 * 182pt corner radius against the template's 185.4pt. That is a fifth of a pixel at
 * 1024px, so the curve is sampled rather than hand-fitted with Beziers.
 */
export function squirclePath(centre: number, half: number, steps = 360, n = 5): string {
  const exponent = 2 / n;
  const points: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = centre + half * Math.sign(c) * Math.abs(c) ** exponent;
    const y = centre + half * Math.sign(s) * Math.abs(s) ** exponent;
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${points[0]}L${points.slice(1).join("L")}Z`;
}
