// Root positions only, scene east/north metres. Authored courtyard trees are preserved.
export function compileTreeExclusions(zones = []) {
  const result = [];
  for (const zone of zones) {
    if (zone?.type === 'rect') {
      const { x, y, front, width, depth } = zone;
      if (![x, y, front, width, depth].every(Number.isFinite) || width <= 0 || depth <= 0) continue;
      const c = Math.cos(front), s = Math.sin(front), hw = width / 2, hd = depth / 2;
      const rx = Math.abs(s) * hw + Math.abs(c) * hd, rn = Math.abs(c) * hw + Math.abs(s) * hd;
      result.push({ type: 'rect', x, y, c, s, hw, hd, bounds: [x - rx, y - rn, x + rx, y + rn] });
    } else if (zone?.type === 'polygon') {
      const p = zone.polygon_scene_EN;
      if (!Array.isArray(p) || p.length < 3 || !p.every(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite))) continue;
      const points = p.map(q => q.slice());
      result.push({ type: 'polygon', points, bounds: [Math.min(...points.map(q => q[0])), Math.min(...points.map(q => q[1])),
        Math.max(...points.map(q => q[0])), Math.max(...points.map(q => q[1]))] });
    }
  }
  return result;
}

export function exclusionsInBounds(zones, x0, n0, x1, n1) {
  return zones.filter(z => z.bounds[0] <= x1 && z.bounds[2] >= x0 && z.bounds[1] <= n1 && z.bounds[3] >= n0);
}

export function treeExcluded(zones, x, north) {
  for (const z of zones) {
    const b = z.bounds;
    if (x < b[0] || x > b[2] || north < b[1] || north > b[3]) continue;
    if (z.type === 'rect') {
      const dx = x - z.x, dn = north - z.y;
      if (Math.abs(-z.s * dx + z.c * dn) <= z.hw && Math.abs(z.c * dx + z.s * dn) <= z.hd) return true;
    } else {
      let inside = false;
      const p = z.points;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[j], b = p[i], dx = b[0] - a[0], dn = b[1] - a[1];
        const cross = (x - a[0]) * dn - (north - a[1]) * dx;
        if (Math.abs(cross) < 1e-8 && x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0]) &&
          north >= Math.min(a[1], b[1]) && north <= Math.max(a[1], b[1])) return true;
        if ((a[1] > north) !== (b[1] > north) && x < a[0] + (north - a[1]) * dx / dn) inside = !inside;
      }
      if (inside) return true;
    }
  }
  return false;
}
