// Camera hashes contain scene coordinates only, never configuration or analytics data.
export const fold = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function encodeView(position, target, mode = 'study') {
  const xyz = v => (Array.isArray(v) ? v : [v.x, v.y, v.z]).map(n => Number(n).toFixed(2)).join(',');
  return '#view=1&c=' + xyz(position) + '&t=' + xyz(target) + '&mode=' + (mode === 'novel' ? 'novel' : 'study');
}
export function decodeView(hash, width = 120000, height = 120000) {
  if (!hash || hash.length > 350) return null;
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (p.get('view') !== '1') return null;
  const parse = key => {
    const s = p.get(key); if (!s || !/^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(s)) return null;
    const v = s.split(',').map(Number);
    return v.every(Number.isFinite) ? v : null;
  };
  const c = parse('c'), t = parse('t'); if (!c || !t) return null;
  if (c[1] < -100 || c[1] > 350000 || t[1] < -100 || t[1] > 20000) return null;
  if (Math.abs(t[0]) > width / 2 + 2000 || Math.abs(t[2]) > height / 2 + 2000) return null;
  if (Math.abs(c[0]) > width / 2 + 320000 || Math.abs(c[2]) > height / 2 + 320000) return null;
  const d = Math.hypot(...c.map((n, i) => n - t[i]));
  if (d < 18 || d > 320000) return null;
  return { position: c, target: t, mode: p.get('mode') === 'novel' ? 'novel' : 'study' };
}
export function searchPlaces(items, query, novel = false, limit = 12) {
  const q = fold(query), words = q.split(' ').filter(Boolean);
  if (!q) return items.filter(p => !p.story && p.featured).slice(0, limit);
  return items.filter(p => (novel || !p.story) && words.every(w => p.search.includes(w)))
    .map(p => ({ p, score: p.search === q ? 0 : p.search.startsWith(q) ? 1 : p.featured ? 2 : 3 }))
    .sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name, 'vi'))
    .slice(0, limit).map(r => r.p);
}
