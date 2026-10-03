// Live high-resolution imagery near the camera (Esri World Imagery via ArcGIS Location Platform).
// Tiles are streamed from the provider at view time, never stored in this project (provider terms).
// For each nearby terrain tile, the covering Web-Mercator tiles (zoom 16, ~2.4 m/px here) are drawn into one
// canvas texture; the terrain tile gets a second UV set (uv1) that maps its vertices onto that canvas.
import * as THREE from 'three';
import { patchTerrainMaterial } from './shaders.js';

const ZOOM = 16;
const CONCURRENT = 12;

/** UTM (WGS84, northern hemisphere) -> [lon, lat] in degrees. */
export function utmToLonLat(E, N, zone) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = E - 500000, M = N / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const fp = mu + (1.5 * e1 - (27 / 32) * e1 ** 3) * Math.sin(2 * mu) + ((21 / 16) * e1 * e1 - (55 / 32) * e1 ** 4) * Math.sin(4 * mu)
    + ((151 / 96) * e1 ** 3) * Math.sin(6 * mu) + ((1097 / 512) * e1 ** 4) * Math.sin(8 * mu);
  const s = Math.sin(fp), c = Math.cos(fp), t = Math.tan(fp);
  const C1 = ep2 * c * c, T1 = t * t, N1 = a / Math.sqrt(1 - e2 * s * s), R1 = (a * (1 - e2)) / (1 - e2 * s * s) ** 1.5;
  const D = x / (N1 * k0);
  const lat = fp - ((N1 * t) / R1) * (D * D / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / c;
  return [(zone - 1) * 6 - 180 + 3 + (lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

/** lon/lat -> fractional Web-Mercator tile coordinates at zoom z. */
function mercTile(lon, lat, z) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
}

export class StreamedImagery {
  constructor(meta, { key, template, maxTiles = 8, anisotropy = 4, onCredit, onError }) {
    this.key = key;
    this.template = template;   // optional XYZ URL template '{z}/{x}/{y}' (other providers / testing)
    this.ce = meta.centre_utm[0];
    this.cn = meta.centre_utm[1];
    this.zone = parseInt(String(meta.crs).slice(-2), 10);   // EPSG:32648 -> 48
    this.maxTiles = maxTiles;
    this.anisotropy = anisotropy;
    this.onCredit = onCredit;
    this.onError = onError;
    this.entries = new Map();   // terrain tile key -> { state, material, texture, lastUsed }
    this.queue = [];
    this.active = 0;
    this.failed = false;
    this.frame = 0;
  }

  /** world (x, z) -> fractional tile coords at ZOOM */
  tileCoord(wx, wz) {
    const [lon, lat] = utmToLonLat(wx + this.ce, -wz + this.cn, this.zone);
    return mercTile(lon, lat, ZOOM);
  }

  /** Mercator tile window covering a terrain tile (cached on the tile record). */
  frameOf(t, wxMin, wxMax, wzMin, wzMax) {
    if (t.merc) return t.merc;
    const corners = [[wxMin, wzMin], [wxMax, wzMin], [wxMin, wzMax], [wxMax, wzMax]].map(([x, z]) => this.tileCoord(x, z));
    const x0 = Math.floor(Math.min(...corners.map((c) => c[0]))), x1 = Math.floor(Math.max(...corners.map((c) => c[0])));
    const y0 = Math.floor(Math.min(...corners.map((c) => c[1]))), y1 = Math.floor(Math.max(...corners.map((c) => c[1])));
    t.merc = { x0, y0, nx: x1 - x0 + 1, ny: y1 - y0 + 1 };
    return t.merc;
  }

  /** uv1 for a vertex at world (x, z) inside the tile's canvas. */
  uv1(t, wx, wz) {
    const [mx, my] = this.tileCoord(wx, wz), f = t.merc;
    return [(mx - f.x0) / f.nx, 1 - (my - f.y0) / f.ny];
  }

  url(z, x, y) {
    if (this.template) return this.template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    return `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}?token=${encodeURIComponent(this.key)}`;
  }

  pump() {
    while (this.active < CONCURRENT && this.queue.length) {
      const job = this.queue.shift();
      if (job.entry.cancelled) { job.done(null); continue; }
      this.active++;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { this.active--; job.done(img); this.pump(); };
      img.onerror = () => { this.active--; job.done(null, true); this.pump(); };
      img.src = job.url;
    }
  }

  /** Material with high-res imagery for a LOD-0 tile, or null while loading / if unavailable. */
  materialFor(t, shared, water, maskXf, crop) {
    if (this.failed || !t.merc) return null;
    const key = `${t.tx}_${t.ty}`;
    let e = this.entries.get(key);
    if (!e) {
      e = { state: 'loading', lastUsed: this.frame };
      this.entries.set(key, e);
      const f = t.merc;
      const canvas = document.createElement('canvas');
      canvas.width = f.nx * 256;
      canvas.height = f.ny * 256;
      const ctx = canvas.getContext('2d');
      let left = f.nx * f.ny, errors = 0;
      for (let j = 0; j < f.ny; j++) {
        for (let i = 0; i < f.nx; i++) {
          this.queue.push({ entry: e, url: this.url(ZOOM, f.x0 + i, f.y0 + j), done: (img, err) => {
            if (img) ctx.drawImage(img, i * 256, j * 256);
            if (err) errors++;
            if (--left === 0) {
              if (e.cancelled) return;                   // dropped while loading
              if (errors === f.nx * f.ny) {             // nothing loaded: bad key, quota, or offline
                this.failed = true;
                e.state = 'failed';
                this.onError?.();
                return;
              }
              const tex = new THREE.CanvasTexture(canvas);
              tex.colorSpace = THREE.SRGBColorSpace;
              tex.channel = 1;                           // sample with uv1
              tex.anisotropy = this.anisotropy;
              const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
              const lat = utmToLonLat(t.center.x + this.ce, -t.center.z + this.cn, this.zone)[1];
              const texelM = (40075016 * Math.cos((lat * Math.PI) / 180)) / 2 ** ZOOM / 256;
              patchTerrainMaterial(m, e.water || water, shared, { maskXf: e.maskXf || maskXf, texelM, crop: e.crop });
              Object.assign(e, { state: 'ready', material: m, texture: tex });
              this.onCredit?.(true);
            }
          } });
        }
      }
      Object.assign(e, { water, maskXf, crop });
      this.pump();
    }
    e.lastUsed = this.frame;
    return e.state === 'ready' ? e.material : null;
  }

  /** Release least recently used canvases beyond the budget; returns materials that were dropped. */
  release() {
    this.frame++;
    const dropped = [];
    const all = [...this.entries.entries()];
    if (all.length <= this.maxTiles) return dropped;
    all.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, e] of all.slice(0, all.length - this.maxTiles)) {
      if (e.lastUsed >= this.frame - 1) break;            // still in use
      e.cancelled = true;
      if (e.material) { dropped.push(e.material); e.material.dispose(); e.texture.dispose(); }
      this.entries.delete(key);
    }
    return dropped;
  }
}
