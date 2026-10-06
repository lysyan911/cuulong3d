// Three authored levels, with a small dead band to keep boundary crossings quiet.
export function touristLOD(id, spec, distance, active) {
  if (distance > (spec.maxR || 7000)) return null;
  const near = spec.nearR || 360, mid = spec.midR || 1300, margin = spec.lodMargin || 45;
  if (active === id && distance < near + margin) return id;
  if (active === spec.mid && distance >= near - margin && distance < mid + margin) return spec.mid;
  if (active === spec.lod && distance >= mid - margin) return spec.lod;
  return distance < near ? id : distance < mid ? spec.mid : spec.lod;
}

// Unnamed OSM places need a coordinate match; their shared name cannot identify them.
export function landmarkReplaced(place, heroes, excluded = []) {
  return excluded.includes(place.name) || heroes.some(h =>
    (h.replaces || []).includes(place.name) || (h.replaceAt || []).some(p =>
      p.name === place.name && Math.hypot(p.x - place.x, p.y - place.y) < 1));
}
