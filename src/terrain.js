// Chunked terrain: 64x64-cell tiles (60 m cells), each tile picks a level of detail from its
// distance to the camera (step 1, 2, 4, 8, 16 cells). Skirts hide cracks between LODs.
// Heights are bicubic (no creases along the 60 m grid). Hill tiles (Bảy Núi, Núi Sam, Ba Thê) use the 30 m DEM
// (relief/*.bin.z) plus fine roughness on steep ground, and get finer meshes (15 m close up) at larger distances.
// Imagery: 20 m texture per 26.9 km group always; near the camera, 10 m "detail" sub-tiles (imagery + water)
// are loaded on demand and the least recently used ones are released (GPU memory on integrated graphics).
import * as THREE from 'three';
import { patchTerrainMaterial } from './shaders.js';
import { splitShoreSteps } from './shore.js';

const MAX_LOD = 4;
const REBUILDS_PER_FRAME = 10;
const DETAIL_LOD = 1;            // tiles at LOD <= this use 10 m detail textures
const HILL_RANGE = 40;           // metres of relief that make a tile a "hill tile" (finer mesh)
const HILL_STEP = [1 / 3, 2 / 3, 1, 2, 4];   // hill tile vertex spacing per LOD, in 60 m cells (20 m close up)
const BUILD_MS = 10;             // terrain rebuild budget per frame
const MERGE_LOD = 3;             // tiles this coarse are drawn merged per texture group (one draw instead of up to 49)
const SLICE_MS = 3;              // the detailed (LOD 0) tiles are built in steps, this long per frame (no hitch)

// Catmull-Rom weights: C1-smooth and passes through the samples (keeps peaks)
function crw(t, w) {
  const t2 = t * t, t3 = t2 * t;
  w[0] = (-t3 + 2 * t2 - t) / 2; w[1] = (3 * t3 - 5 * t2 + 2) / 2; w[2] = (-3 * t3 + 4 * t2 + t) / 2; w[3] = (t3 - t2) / 2;
}
const WU = new Float64Array(4), WV = new Float64Array(4);
// value noise for fine roughness (deterministic, so houses and trees sit on the same ground)
function hash2(x, y) { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}
const smooth01 = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
// signed distance (m) from (x, y) to a polygon [[x, y], ...]: negative inside
function polyDist(P, x, y) {
  let d = Infinity, inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ax, ay] = P[j], [bx, by] = P[i];
    if ((by > y) !== (ay > y) && x < (ax - bx) * (y - by) / (ay - by) + bx) inside = !inside;
    const dx = bx - ax, dy = by - ay, t = Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0), 1);
    d = Math.min(d, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return inside ? -d : d;
}

export class Terrain {
  constructor(meta, heights, textures, shared, { dataUrl, maxDetail = 10, anisotropy = 4, imagery = null, surface = null } = {}) {
    this.meta = meta;
    this.surface = surface;
    this.h = heights;                         // Float32Array, metres, row 0 = north
    this.R = meta.rows;
    this.C = meta.cols;
    this.res = meta.grid_res_m;
    this.ex = meta.vert_exag;
    this.T = meta.tile;
    this.G = meta.group;
    this.W = meta.width_m;
    this.H = meta.height_m;
    this.lodBias = 0;
    this.shared = shared;
    this.dataUrl = dataUrl;
    this.maxDetail = maxDetail;
    this.anisotropy = anisotropy;
    this.loader = new THREE.TextureLoader();
    this.imagery = imagery;   // optional StreamedImagery (live high-res tiles for the nearest tiles)
    this.detail = new Map();   // "gx_gy_sx_sy" -> { state, material, textures, lastUsed }
    this.jobs = new Map();     // tile -> { lod, steps }: detailed tiles being built over a few frames
    this.frame = 0;
    this.subOf = {};            // tile index within group -> sub-tile index
    for (const st of meta.subtiles) {
      if (st.g[0] !== 0 || st.g[1] !== 0) continue;
      const [c0, c1, r0, r1] = st.tiles;
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) this.subOf[`${c}_${r}`] = st;
    }
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.bankMaterial = new THREE.MeshStandardMaterial({ color: 0x786b49, roughness: 1, flatShading: true, side: THREE.DoubleSide });

    // one material per texture group (same shader program, different textures)
    this.materials = [];
    for (let gy = 0; gy < meta.groups[1]; gy++) {
      this.materials[gy] = [];
      for (let gx = 0; gx < meta.groups[0]; gx++) {
        const m = new THREE.MeshStandardMaterial({ map: textures.sat[gy][gx], roughness: 0.95, metalness: 0,
                                                   side: THREE.DoubleSide });
        patchTerrainMaterial(m, textures.water[gy][gx], shared, { texelM: 20, crop: textures.crop?.[gy]?.[gx] });
        this.materials[gy][gx] = m;
      }
    }

    this.tiles = [];
    const ntx = Math.ceil((this.C - 1) / this.T), nty = Math.ceil((this.R - 1) / this.T);
    for (let ty = 0; ty < nty; ty++) {
      for (let tx = 0; tx < ntx; tx++) {
        const j0 = tx * this.T, i0 = ty * this.T;
        const j1 = Math.min(j0 + this.T, this.C - 1), i1 = Math.min(i0 + this.T, this.R - 1);
        const gx = Math.floor(j0 / this.G), gy = Math.floor(i0 / this.G);
        let hmax = 0, hsum = 0, n = 0;
        for (let i = i0; i <= i1; i += 4) for (let j = j0; j <= j1; j += 4) {
          const v = this.h[i * this.C + j]; hmax = Math.max(hmax, v); hsum += v; n++;
        }
        const center = new THREE.Vector3(this.wx((j0 + j1) / 2), (hsum / n) * this.ex, this.wz((i0 + i1) / 2));
        const mesh = new THREE.Mesh(undefined, [this.materials[gy][gx], this.bankMaterial]);
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        this.group.add(mesh);
        this.tiles.push({ tx, ty, j0, j1, i0, i1, gx, gy, center, hmax, lod: -1, mesh, base: this.materials[gy][gx], hill: false,
                          baseWater: textures.water[gy][gx], crop: textures.crop?.[gy]?.[gx] });
      }
    }
  }

  // grid index -> world
  wx(j) { return -this.W / 2 + (j + 0.5) * this.res; }
  wz(i) { return -(this.H / 2 - (i + 0.5) * this.res); }

  rawHeightAtGrid(i, j) {
    i = Math.min(Math.max(i, 0), this.R - 1);
    j = Math.min(Math.max(j, 0), this.C - 1);
    return this.h[i * this.C + j];
  }

  /** Load the 30 m hill windows (meta.relief); call once before anything samples heights. */
  async loadRelief() {
    const R = this.meta.relief;
    this.relief = new Map();
    if (!R) return;
    await Promise.all(R.tiles.map(async ([tx, ty, r0, c0, rows, cols]) => {
      const res = await fetch(`${this.dataUrl}relief/r_${tx}_${ty}.bin.z`);
      const buf = await new Response(res.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
      const u16 = new Uint16Array(buf), h = new Float32Array(u16.length);
      let lo = Infinity, hi = -Infinity;
      for (let q = 0; q < u16.length; q++) { h[q] = u16[q] / 10; lo = Math.min(lo, h[q]); hi = Math.max(hi, h[q]); }
      this.relief.set(`${tx}_${ty}`, { tx, ty, r0, c0, rows, cols, h, hill: hi - lo > HILL_RANGE });
    }));
    this.ntx = Math.ceil((this.C - 1) / this.T);
    this.reliefAt = new Array(this.ntx * Math.ceil((this.R - 1) / this.T)).fill(null);
    for (const w of this.relief.values()) {                // which sides blend back to the 60 m grid
      w.open = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]) => !this.relief.has(`${w.tx + dx}_${w.ty + dy}`));
      this.reliefAt[w.ty * this.ntx + w.tx] = w;
    }
    for (const t of this.tiles) {
      const w = this.relief.get(`${t.tx}_${t.ty}`);
      t.hill = !!(w && w.hill);
    }
  }

  /** Terrain height (metres, unexaggerated) at scene coords (x east, y north): bicubic 60 m, or the 30 m hill DEM. */
  heightAtRaw(x, y) {
    const fj = (x + this.W / 2) / this.res - 0.5, fi = (this.H / 2 - y) / this.res - 0.5;
    const tx = Math.floor(fj / this.T), ty = Math.floor(fi / this.T);
    const w = this.reliefAt && tx >= 0 && ty >= 0 && tx < this.ntx ? this.reliefAt[ty * this.ntx + tx] : null;
    if (!w) return this.gridBicubic(fi, fj);
    // blend towards the 60 m grid near tile sides that have no 30 m neighbour
    const tm = this.T * this.res, lx = (fj - w.tx * this.T) * this.res, ly = (fi - w.ty * this.T) * this.res;
    let k = 1;
    if (w.open[0]) k = Math.min(k, smooth01(0, 240, lx));
    if (w.open[1]) k = Math.min(k, smooth01(0, 240, tm - lx));
    if (w.open[2]) k = Math.min(k, smooth01(0, 240, ly));
    if (w.open[3]) k = Math.min(k, smooth01(0, 240, tm - ly));
    const fr = (this.H / 2 - y) / 30 - 0.5 - w.r0, fc = (x + this.W / 2) / 30 - 0.5 - w.c0;
    const H = w.h, cols = w.cols;
    const i = Math.min(Math.max(Math.floor(fr), 1), w.rows - 3), j = Math.min(Math.max(Math.floor(fc), 1), cols - 3);
    crw(fc - j, WU); crw(fr - i, WV);
    let h = 0;
    for (let a = 0; a < 4; a++) {
      const o = (i - 1 + a) * cols + j;
      h += WV[a] * (WU[0] * H[o - 1] + WU[1] * H[o] + WU[2] * H[o + 1] + WU[3] * H[o + 2]);
    }
    if (w.hill) {
      // fine roughness on steep ground only (gullies, rock steps): +-1.8 m, 15-45 m wavelengths
      const o = i * cols + j;
      const g = Math.hypot(H[o + 1] - H[o - 1], H[o + cols] - H[o - cols]) / 60;
      const steep = smooth01(0.08, 0.4, g);
      if (steep > 0) h += steep * 1.8 * ((vnoise(x / 41, y / 41) - 0.5) * 1.3 + (vnoise(x / 16 + 7.3, y / 16) - 0.5) * 0.7);
    }
    return k >= 1 ? h : this.gridBicubic(fi, fj) * (1 - k) + h * k;
  }

  gridBicubic(fi, fj) {
    const C = this.C, R = this.R, A = this.h;
    const i = Math.floor(fi), j = Math.floor(fj);
    crw(fj - j, WU); crw(fi - i, WV);
    let h = 0;
    for (let a = 0; a < 4; a++) {
      const r = Math.min(Math.max(i - 1 + a, 0), R - 1) * C;
      for (let b = 0; b < 4; b++) h += WV[a] * WU[b] * A[r + Math.min(Math.max(j - 1 + b, 0), C - 1)];
    }
    return h;
  }

  heightAt(x, y) {
    const raw = this.heightAtRaw(x, y);
    const sceneHeight = this.surface ? this.surface.sceneHeight(x, y, raw) : raw * this.ex;
    const h = (this.wetland ? this.wetland.sceneHeight(x, y, sceneHeight) : sceneHeight) / this.ex;
    return this.patches ? this.patched(x, y, h) : h;
  }

  /**
   * Ground edits handed over with the tourist places (web/data/tourist-terrain-handoff.json): temple courts and
   * terraces cut / filled to their level, stair ramps, the bank around Hồ Thủy Liêm (Núi Cấm). The 30 m DEM runs
   * smoothly through what are engineered terraces. Courts get a margin of about half a mesh cell (20 m near) so the
   * old slope can't poke through them, then a feathered edge. Later patches win where they overlap. Call before
   * anything samples heights (true scale only).
   */
  setPatches(data) {
    if (this.ex !== 1 || !data?.places) return;
    const list = [], mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const add = (poly, o) => {
      const r = (o.margin || 0) + (o.feather || 0), xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
      list.push({ poly, ...o, box: [Math.min(...xs) - r, Math.min(...ys) - r, Math.max(...xs) + r, Math.max(...ys) + r] });
    };
    for (const place of data.places) {
      for (const m of place.masks || []) if (m.kind === 'flat-court')
        add(m.polygon_scene_EN, { h: m.target_height_m - 0.15, margin: 8, feather: Math.max(m.feather_m || 3, 12) });
      for (const p of place.patches || []) {
        if (p.kind === 'terrace') add(p.polygon_scene_EN, { h: p.height_m, margin: 0, feather: Math.max(p.blend_outside_m || 1.5, 4) });
        else if (p.kind === 'linear-ramp') {
          // the flight runs along the pair of sides as long as it; its two ends are the other sides, the lower end low
          const P = p.polygon_scene_EN, len = Math.abs(p.local_end_Y - p.local_start_Y);
          const L0 = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]), L1 = Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1]);
          const along1 = Math.abs(L1 - len) < Math.abs(L0 - len);
          let a = along1 ? mid(P[0], P[1]) : mid(P[1], P[2]), b = along1 ? mid(P[2], P[3]) : mid(P[3], P[0]);
          if (this.heightAt(a[0], a[1]) > this.heightAt(b[0], b[1])) [a, b] = [b, a];
          add(P, { h: Math.min(p.start_height_m, p.end_height_m), h1: Math.max(p.start_height_m, p.end_height_m), a, b,
                   margin: 0, feather: Math.max(p.blend_outside_m || 0.6, 2) });
        }
      }
      // the lake itself is the map's water (surface.js, already at its level); only its bank rises around it
      if (place.lake?.polygon_scene_EN && place.banks?.top_height_m) {
        const B = place.banks;
        add(place.lake.polygon_scene_EN, { h: B.top_height_m, margin: B.width_m || 2.8, feather: Math.max(B.feather_m || 3, 10), ring: true });
      }
    }
    this.patches = list;
  }

  patched(x, y, h) {
    for (const p of this.patches) {
      const b = p.box;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      const d = polyDist(p.poly, x, y);
      if (p.ring && d < 0) continue;
      const w = p.feather ? 1 - smooth01(p.margin, p.margin + p.feather, d) : d <= p.margin ? 1 : 0;
      if (w <= 0) continue;
      let t = p.h;
      if (p.a) {
        const [ax, ay] = p.a, dx = p.b[0] - ax, dy = p.b[1] - ay;
        t += (p.h1 - p.h) * Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0), 1);
      }
      h += (t - h) * w;
    }
    return h;
  }

  heightAtGrid(i, j) { return this.heightAt(this.wx(j), -this.wz(i)); }
  waterHeightAt(x, y) {
    if (this.wetland && this.wetland.floodAt(x, y) > .8) return this.wetland.level;
    return this.surface ? this.surface.waterHeight(x, y) : this.heightAt(x, y) * this.ex;
  }

  build(t, lod) { const g = this.buildSteps(t, lod); let r; while (!(r = g.next()).done); return r.value; }

  // the tile geometry, built in steps (yield = a good place to pause until the next frame)
  *buildSteps(t, lod) {
    const s = t.hill ? HILL_STEP[lod] : lod === 0 && this.surface ? 1 / 3 : 1 << lod;
    const ex = this.ex, res = this.res, G = this.G;
    const cols = [], rows = [];
    for (let q = 0; q < Math.ceil((t.j1 - t.j0) / s); q++) cols.push(t.j0 + q * s);
    cols.push(t.j1);
    for (let q = 0; q < Math.ceil((t.i1 - t.i0) / s); q++) rows.push(t.i0 + q * s);
    rows.push(t.i1);
    const nx = cols.length, ny = rows.length;
    const nGrid = nx * ny, nSkirt = 2 * (nx + ny);
    let pos = new Float32Array((nGrid + nSkirt) * 3);
    let nor = new Float32Array((nGrid + nSkirt) * 3);
    let uv = new Float32Array((nGrid + nSkirt) * 2);
    const confidence = new Float32Array(nGrid);
    const gx = Math.floor(t.j0 / G), gy = Math.floor(t.i0 / G);

    // heights once per vertex on a grid with a one-vertex ring around it (for the normals), not 5x per vertex
    const ex1 = [cols[0] - s, ...cols, cols[nx - 1] + s], ey1 = [rows[0] - s, ...rows, rows[ny - 1] + s];
    const HE = new Float32Array((nx + 2) * (ny + 2));
    for (let r = 0; r < ny + 2; r++) {
      for (let c = 0; c < nx + 2; c++) HE[r * (nx + 2) + c] = this.heightAtGrid(ey1[r], ex1[c]);
      if ((r & 7) === 7) yield;
    }
    const rowOf = new Map(rows.map((v, q) => [v, q])), colOf = new Map(cols.map((v, q) => [v, q]));
    const writeVertex = (k, i, j, drop) => {
      const r = rowOf.get(i) + 1, c = colOf.get(j) + 1, W2 = nx + 2;
      const h = HE[r * W2 + c];
      pos[k * 3] = this.wx(j);
      pos[k * 3 + 1] = h * ex - drop;
      pos[k * 3 + 2] = this.wz(i);
      if (k < nGrid && this.surface) confidence[k] = this.wetland && this.wetland.floodAt(pos[k * 3], -pos[k * 3 + 2]) > .8
        ? 0 : this.surface.waterAt(pos[k * 3], -pos[k * 3 + 2]);
      const hx = (HE[r * W2 + c + 1] - HE[r * W2 + c - 1]) / ((ex1[c + 1] - ex1[c - 1]) * res) * ex;
      const hz = (HE[(r + 1) * W2 + c] - HE[(r - 1) * W2 + c]) / ((ey1[r + 1] - ey1[r - 1]) * res) * ex;  // +i = +z (south)
      const l = Math.hypot(hx, 1, hz);
      nor[k * 3] = -hx / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = -hz / l;
      uv[k * 2] = (j - gx * G) / G;
      uv[k * 2 + 1] = 1 - (i - gy * G) / G;
    };

    let k = 0;
    for (let r = 0; r < ny; r++) {
      for (const j of cols) writeVertex(k++, rows[r], j, 0);
      if ((r & 15) === 15) yield;
    }
    let idx = [];
    for (let r = 0; r < ny - 1; r++) {
      for (let c = 0; c < nx - 1; c++) {
        const a = r * nx + c, b = a + 1, d = a + nx, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    // skirts: duplicate each edge vertex lower down and stitch (double-sided faces)
    const drop = 20 * s * ex;
    const edge = (list) => {
      const start = k;
      for (const [i, j] of list) writeVertex(k++, i, j, drop);
      return start;
    };
    const top = cols.map((j, c) => [rows[0], j]), bottom = cols.map((j) => [rows[ny - 1], j]);
    const left = rows.map((i) => [i, cols[0]]), right = rows.map((i) => [i, cols[nx - 1]]);
    const stitch = (gridIdx, skirtStart) => {
      for (let q = 0; q < gridIdx.length - 1; q++) {
        const a = gridIdx[q], b = gridIdx[q + 1], c = skirtStart + q, d = skirtStart + q + 1;
        idx.push(a, c, b, b, c, d);
      }
    };
    stitch(cols.map((_, c) => c), edge(top));
    stitch(cols.map((_, c) => (ny - 1) * nx + c), edge(bottom));
    stitch(rows.map((_, r) => r * nx), edge(left));
    stitch(rows.map((_, r) => r * nx + nx - 1), edge(right));

    let surfaceIndexCount = idx.length, bankIndexCount = 0;
    if (this.surface && lod <= 1) {
      yield;
      const clipped = yield* splitShoreSteps(pos, nor, uv, idx, confidence, (nx - 1) * (ny - 1) * 6,
        (x, y) => this.waterHeightAt(x, y),
        (x, y) => Math.max(this.heightAt(x, y) * ex, this.waterHeightAt(x, y) + this.meta.surface.bank_height_m * ex));
      pos = clipped.position; nor = clipped.normal; uv = clipped.uv; idx = clipped.indices;
      surfaceIndexCount = clipped.surfaceIndexCount; bankIndexCount = clipped.bankIndexCount;
    }
    if (lod <= 1) yield;
    const g = new THREE.BufferGeometry();
    g.addGroup(0, surfaceIndexCount, 0);
    if (bankIndexCount) g.addGroup(surfaceIndexCount, bankIndexCount, 1);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (lod === 0 && this.imagery) {   // second UV set onto the streamed high-res canvas
      this.imagery.frameOf(t, this.wx(t.j0), this.wx(t.j1), this.wz(t.i0), this.wz(t.i1));
      // UTM -> Web Mercator is practically affine over one 3.84 km tile: exact at the corners, interpolated inside
      const x0 = this.wx(t.j0), x1 = this.wx(t.j1), z0 = this.wz(t.i0), z1 = this.wz(t.i1);
      const c00 = this.imagery.uv1(t, x0, z0), c10 = this.imagery.uv1(t, x1, z0);
      const c01 = this.imagery.uv1(t, x0, z1), c11 = this.imagery.uv1(t, x1, z1);
      const uv1 = new Float32Array(pos.length / 3 * 2);
      for (let q = 0; q < pos.length / 3; q++) {
        const u = (pos[q * 3] - x0) / (x1 - x0), v = (pos[q * 3 + 2] - z0) / (z1 - z0);
        for (let e = 0; e < 2; e++) {
          uv1[q * 2 + e] = (c00[e] * (1 - u) + c10[e] * u) * (1 - v) + (c01[e] * (1 - u) + c11[e] * u) * v;
        }
      }
      g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    }
    yield;
    const ia = pos.length / 3 > 65535 ? new Uint32Array(idx.length) : new Uint16Array(idx.length);
    for (let q = 0; q < idx.length; q += 65536) {        // (a plain array would be converted in one go by setIndex)
      ia.set(idx.slice(q, q + 65536), q);
      if (lod <= 1 && q && (q & 262143) === 0) yield;
    }
    g.setIndex(new THREE.BufferAttribute(ia, 1));
    g.computeBoundingSphere();
    return g;
  }

  /** 10 m detail entry for a tile's sub-tile, loading it if needed ({state, material, water, maskXf}). */
  detailFor(t) {
    const st = this.subOf[`${t.tx - t.gx * 7}_${t.ty - t.gy * 7}`];
    if (!st) return null;
    const key = `${t.gx}_${t.gy}_${st.s[0]}_${st.s[1]}`;
    let d = this.detail.get(key);
    if (!d) {
      d = { state: 'loading', lastUsed: this.frame };
      this.detail.set(key, d);
      const [c0, c1, r0, r1] = st.tiles, T = this.T, G = this.G;
      const spanU = (c1 - c0) * T, spanV = (r1 - r0) * T;
      Promise.all([
        this.loader.loadAsync(`${this.dataUrl}tex/sathi_${key}.jpg`),
        this.loader.loadAsync(`${this.dataUrl}tex/waterhi_${key}.png`),
      ]).then(([img, water]) => {
        img.colorSpace = THREE.SRGBColorSpace;
        img.anisotropy = this.anisotropy;
        img.repeat.set(G / spanU, G / spanV);                       // group UV -> sub-tile UV
        img.offset.set((-c0 * T) / spanU, 1 - G / spanV + (r0 * T) / spanV);
        water.colorSpace = THREE.NoColorSpace;
        const m = new THREE.MeshStandardMaterial({ map: img, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
        const maskXf = [img.repeat.x, img.repeat.y, img.offset.x, img.offset.y];   // same mapping as the imagery
        patchTerrainMaterial(m, water, this.shared, { maskXf, texelM: 10, crop: t.crop });
        Object.assign(d, { state: 'ready', material: m, textures: [img, water], water, maskXf });
      }).catch(() => { d.state = 'failed'; });
    }
    d.lastUsed = this.frame;
    return d;
  }

  releaseDetail() {
    const ready = [...this.detail.entries()].filter(([, d]) => d.state === 'ready');
    if (ready.length <= this.maxDetail) return;
    ready.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, d] of ready.slice(0, ready.length - this.maxDetail)) {
      if (d.lastUsed === this.frame) break;               // still on screen
      for (const t of this.tiles) if (t.mesh.material[0] === d.material) t.mesh.material[0] = t.base;
      d.material.dispose();
      for (const tex of d.textures) tex.dispose();
      this.detail.delete(key);
    }
  }

  update(camera) {
    this.frame++;
    let rebuilt = 0;
    const frameStart = performance.now();
    const tileWorld = this.T * this.res;
    for (const t of this.tiles) {
      const d = camera.position.distanceTo(t.center);
      let lod = Math.floor(Math.log2(Math.max(d, 1) / (tileWorld * 1.2))) + 1 + this.lodBias - (t.hill ? 1 : 0);
      lod = Math.min(Math.max(lod, 0), MAX_LOD);
      const overBudget = performance.now() - frameStart > BUILD_MS;
      const heavy = lod === 0 || (t.hill && lod <= 1);               // the slow builds (12-37 ms): in steps over a few frames
      if (heavy && t.lod !== lod && t.lod !== -1) {
        const job = this.jobs.get(t);
        if (!job || job.lod !== lod) this.jobs.set(t, { lod, steps: this.buildSteps(t, lod) });
      } else if (this.jobs.has(t) && lod !== this.jobs.get(t).lod) this.jobs.delete(t);
      else if (lod !== t.lod && (t.lod === -1 || (rebuilt < REBUILDS_PER_FRAME && !overBudget))) {
        if (t.lod === -1 && overBudget) lod = Math.max(lod, 3);      // something cheap now, the real LOD later
        const old = t.mesh.geometry;
        t.mesh.geometry = this.build(t, lod);
        if (old) old.dispose();
        t.lod = lod;
        t.mesh.visible = true;
        rebuilt++;
      }
      let mat = t.base;
      const det = t.lod <= DETAIL_LOD ? this.detailFor(t) : null;
      const ready = !!det && det.state === 'ready';
      if (ready) mat = det.material;
      if (t.lod === 0 && this.imagery && t.mesh.geometry.attributes.uv1) {
        const hi = this.imagery.materialFor(t, this.shared, ready ? det.water : t.baseWater, ready ? det.maskXf : [1, 1, 0, 0], t.crop);
        if (hi) mat = hi;
      }
      t.mesh.material[0] = mat;
    }
    // advance the detailed-tile jobs for SLICE_MS, nearest tiles first; swap each in when it is done
    if (this.jobs.size) {
      const deadline = performance.now() + SLICE_MS;
      const order = [...this.jobs.keys()].sort((a, b) => camera.position.distanceTo(a.center) - camera.position.distanceTo(b.center));
      for (const t of order) {
        const job = this.jobs.get(t);
        let r;
        while (performance.now() < deadline && !(r = job.steps.next()).done);
        if (r && r.done) {
          const old = t.mesh.geometry;
          t.mesh.geometry = r.value;
          if (old) old.dispose();
          t.lod = job.lod;
          this.jobs.delete(t);
        }
        if (performance.now() >= deadline) break;
      }
    }
    this.mergeFar();
    this.releaseDetail();
    if (this.imagery) this.imagery.release();
  }

  // Distant tiles of a texture group share one material: draw them as one merged mesh. Rebuilt (< 1 ms, one group
  // per frame) when one of them changes level; until then that tile draws on its own, so nothing is ever missing.
  mergeFar() {
    if (!this.byGroup) {
      this.byGroup = new Map();
      for (const t of this.tiles) {
        const k = t.gy * 100 + t.gx;
        if (!this.byGroup.has(k)) this.byGroup.set(k, { tiles: [], lods: new Map(), mesh: null, sig: '' });
        this.byGroup.get(k).tiles.push(t);
      }
    }
    let rebuilt = 0;
    for (const G of this.byGroup.values()) {
      const list = G.tiles.filter((t) => t.lod >= MERGE_LOD && t.mesh.material[0] === t.base && !this.jobs.has(t) && t.mesh.geometry);
      const sig = list.map((t) => t.tx * 100000 + t.ty * 10 + t.lod).join();
      G.stale = false;
      if (sig !== G.sig) {
        if (list.length < 2) { G.sig = sig; G.lods = new Map(); }
        else if (rebuilt < 2) {
          rebuilt++;
          G.sig = sig;
          G.lods = new Map(list.map((t) => [t, t.lod]));
          let nv = 0, ni = 0;
          for (const t of list) { nv += t.mesh.geometry.attributes.position.count; ni += t.mesh.geometry.index.count; }
          const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
          const idx = new Uint32Array(ni);
          let v = 0, i = 0;
          for (const t of list) {
            const g = t.mesh.geometry, n = g.attributes.position.count, ix = g.index.array;
            pos.set(g.attributes.position.array, v * 3); nor.set(g.attributes.normal.array, v * 3); uv.set(g.attributes.uv.array, v * 2);
            for (let k = 0; k < ix.length; k++) idx[i + k] = ix[k] + v;
            v += n; i += ix.length;
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
          geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
          geo.setIndex(new THREE.BufferAttribute(idx, 1));
          geo.computeBoundingSphere();
          if (!G.mesh) {
            G.mesh = new THREE.Mesh(geo, list[0].base);
            G.mesh.matrixAutoUpdate = false;
            this.group.add(G.mesh);
          } else { G.mesh.geometry.dispose(); G.mesh.geometry = geo; }
        } else G.stale = true;                      // out of date: its tiles draw on their own this frame
      }
      if (G.mesh) G.mesh.visible = !G.stale && G.lods.size > 0;
      // a tile is drawn by the merged mesh only at the level it was merged with
      for (const t of G.tiles) if (t.lod !== -1) t.mesh.visible = G.stale || G.lods.get(t) !== t.lod || t.mesh.material[0] !== t.base;
    }
  }
}
