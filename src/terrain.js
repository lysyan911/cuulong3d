// Chunked terrain: 64x64-cell tiles (60 m cells), each tile picks a level of detail from its
// distance to the camera (step 1, 2, 4, 8, 16 cells). Skirts hide cracks between LODs.
// Imagery: 20 m texture per 26.9 km group always; near the camera, 10 m "detail" sub-tiles (imagery + water)
// are loaded on demand and the least recently used ones are released (GPU memory on integrated graphics).
import * as THREE from 'three';
import { patchTerrainMaterial } from './shaders.js';

const MAX_LOD = 4;
const REBUILDS_PER_FRAME = 10;
const DETAIL_LOD = 1;            // tiles at LOD <= this use 10 m detail textures

export class Terrain {
  constructor(meta, heights, textures, shared, { dataUrl, maxDetail = 10, anisotropy = 4, imagery = null } = {}) {
    this.meta = meta;
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
    this.frame = 0;
    this.subOf = {};            // tile index within group -> sub-tile index
    for (const st of meta.subtiles) {
      if (st.g[0] !== 0 || st.g[1] !== 0) continue;
      const [c0, c1, r0, r1] = st.tiles;
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) this.subOf[`${c}_${r}`] = st;
    }
    this.group = new THREE.Group();
    this.group.name = 'terrain';

    // one material per texture group (same shader program, different textures)
    this.materials = [];
    for (let gy = 0; gy < meta.groups[1]; gy++) {
      this.materials[gy] = [];
      for (let gx = 0; gx < meta.groups[0]; gx++) {
        const m = new THREE.MeshStandardMaterial({ map: textures.sat[gy][gx], roughness: 0.95, metalness: 0,
                                                   side: THREE.DoubleSide });
        patchTerrainMaterial(m, textures.water[gy][gx], shared, { texelM: 20 });
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
        const mesh = new THREE.Mesh(undefined, this.materials[gy][gx]);
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        this.group.add(mesh);
        this.tiles.push({ tx, ty, j0, j1, i0, i1, gx, gy, center, hmax, lod: -1, mesh, base: this.materials[gy][gx],
                          baseWater: textures.water[gy][gx] });
      }
    }
  }

  // grid index -> world
  wx(j) { return -this.W / 2 + (j + 0.5) * this.res; }
  wz(i) { return -(this.H / 2 - (i + 0.5) * this.res); }

  heightAtGrid(i, j) {
    i = Math.min(Math.max(i, 0), this.R - 1);
    j = Math.min(Math.max(j, 0), this.C - 1);
    return this.h[i * this.C + j];
  }

  /** Terrain height (metres, unexaggerated) at scene coords (x east, y north), bilinear. */
  heightAt(x, y) {
    const fj = (x + this.W / 2) / this.res - 0.5, fi = (this.H / 2 - y) / this.res - 0.5;
    const j = Math.floor(fj), i = Math.floor(fi), u = fj - j, v = fi - i;
    const a = this.heightAtGrid(i, j), b = this.heightAtGrid(i, j + 1);
    const c = this.heightAtGrid(i + 1, j), d = this.heightAtGrid(i + 1, j + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  build(t, lod) {
    const s = 1 << lod, C = this.C, ex = this.ex, res = this.res, G = this.G;
    const cols = [], rows = [];
    for (let j = t.j0; j < t.j1; j += s) cols.push(j);
    cols.push(t.j1);
    for (let i = t.i0; i < t.i1; i += s) rows.push(i);
    rows.push(t.i1);
    const nx = cols.length, ny = rows.length;
    const nGrid = nx * ny, nSkirt = 2 * (nx + ny);
    const pos = new Float32Array((nGrid + nSkirt) * 3);
    const nor = new Float32Array((nGrid + nSkirt) * 3);
    const uv = new Float32Array((nGrid + nSkirt) * 2);
    const gx = Math.floor(t.j0 / G), gy = Math.floor(t.i0 / G);
    const dx = 2 * res;

    const writeVertex = (k, i, j, drop) => {
      const h = this.h[i * C + j];
      pos[k * 3] = this.wx(j);
      pos[k * 3 + 1] = h * ex - drop;
      pos[k * 3 + 2] = this.wz(i);
      const hx = (this.heightAtGrid(i, j + 1) - this.heightAtGrid(i, j - 1)) / dx * ex;
      const hz = (this.heightAtGrid(i + 1, j) - this.heightAtGrid(i - 1, j)) / dx * ex;  // +i = +z (south)
      const l = Math.hypot(hx, 1, hz);
      nor[k * 3] = -hx / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = -hz / l;
      uv[k * 2] = (j - gx * G) / G;
      uv[k * 2 + 1] = 1 - (i - gy * G) / G;
    };

    let k = 0;
    for (const i of rows) for (const j of cols) writeVertex(k++, i, j, 0);
    const idx = [];
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

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (lod === 0 && this.imagery) {   // second UV set onto the streamed high-res canvas
      this.imagery.frameOf(t, this.wx(t.j0), this.wx(t.j1), this.wz(t.i0), this.wz(t.i1));
      const uv1 = new Float32Array((nGrid + nSkirt) * 2);
      for (let q = 0; q < nGrid + nSkirt; q++) uv1.set(this.imagery.uv1(t, pos[q * 3], pos[q * 3 + 2]), q * 2);
      g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    }
    g.setIndex(idx);
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
        patchTerrainMaterial(m, water, this.shared, { maskXf, texelM: 10 });
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
      for (const t of this.tiles) if (t.mesh.material === d.material) t.mesh.material = t.base;
      d.material.dispose();
      for (const tex of d.textures) tex.dispose();
      this.detail.delete(key);
    }
  }

  update(camera) {
    this.frame++;
    let rebuilt = 0;
    const tileWorld = this.T * this.res;
    for (const t of this.tiles) {
      const d = camera.position.distanceTo(t.center);
      let lod = Math.floor(Math.log2(Math.max(d, 1) / (tileWorld * 1.2))) + 1 + this.lodBias;
      lod = Math.min(Math.max(lod, 0), MAX_LOD);
      if (lod !== t.lod && (t.lod === -1 || rebuilt < REBUILDS_PER_FRAME)) {
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
        const hi = this.imagery.materialFor(t, this.shared, ready ? det.water : t.baseWater, ready ? det.maskXf : [1, 1, 0, 0]);
        if (hi) mat = hi;
      }
      t.mesh.material = mat;
    }
    this.releaseDetail();
    if (this.imagery) this.imagery.release();
  }
}
