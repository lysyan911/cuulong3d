// Raised earth bunds near the camera, along the field layout the terrain shader paints (surface.js: canal blocks,
// strips, fields; the rice itself is shaded on the terrain at every LOD). Wider dykes round the blocks. On the Bảy Núi
// plain (Tri Tôn, Tịnh Biên) thốt nốt palms stand along bunds and dykes, alone or in small groups.
import * as THREE from 'three';
import { FIELD, fieldWarped, fieldWorld, blockLayout, hash12 } from './surface.js';

const TILE = 512, MAX_TILES = 24, STEP = 24;
const THOTNOT = 6;                                          // trees.js species
// Bảy Núi plain (scene east / north, m): where thốt nốt palms grow among the fields
const bayNui = (x, y) => x < -9000 && x > -42000 && y < 9000 && y > -36000;

export class PaddyLayer {
  constructor(terrain, { nearR = 1150, trees = null } = {}) {
    this.terrain = terrain; this.surface = terrain.surface; this.nearR = nearR; this.trees = trees;
    this.group = new THREE.Group(); this.group.name = 'paddies';
    this.material = new THREE.MeshStandardMaterial({ color: 0x55703a, roughness: 1, flatShading: true });
    this.tiles = new Map(); this.frame = 0;
  }

  build(tx, ty) {
    const x0 = tx * TILE, y0 = ty * TILE, positions = [], indices = [], palms = [];
    const surface = this.surface, terrain = this.terrain, ex = terrain.ex;
    const height = (x, y) => terrain.heightAt(x, y) * ex;
    const rice = (x, y) => surface.cropAt(x, y) > .8 && (!terrain.wetland || terrain.wetland.floodAt(x, y) < .2)
                           && surface.waterAt(x, y) < .2 && surface.shoreAt(x, y) > 25;
    const [BX, BY] = FIELD.block;
    // a ridge along a polyline of world points: top half width, foot half width, height
    const ridge = (pts, top, foot, hgt) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        if (Math.floor(mx / TILE) !== tx || Math.floor(my / TILE) !== ty) continue;   // each segment in one tile only
        if (!rice(mx, my) || !rice(a[0], a[1]) || !rice(b[0], b[1])) continue;
        const ha = height(a[0], a[1]), hb = height(b[0], b[1]);
        if (Math.abs(ha - hb) > 3) continue;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
        const ring = ([x, y], h) => [[x - nx * foot, h + .04, -y + ny * foot], [x - nx * top, h + hgt * ex, -y + ny * top],
                                     [x + nx * top, h + hgt * ex, -y - ny * top], [x + nx * foot, h + .04, -y - ny * foot]];
        const base = positions.length / 3;
        for (const p of [...ring(a, ha), ...ring(b, hb)]) positions.push(...p);
        for (let j = 0; j < 3; j++) indices.push(base + j, base + j + 4, base + j + 1, base + j + 1, base + j + 4, base + j + 5);
        // thốt nốt palms on the Bảy Núi plain
        if (this.trees && bayNui(mx, my)) {
          const r = hash12(Math.round(mx * 0.37), Math.round(my * 0.53));
          if (r < (top > 1 ? 0.22 : 0.07)) {
            const n = 1 + Math.floor(hash12(Math.round(my), Math.round(mx)) * 4);
            for (let k = 0; k < n; k++) {
              const t = (k + 0.5) / n, px = a[0] + (b[0] - a[0]) * t + nx * (k % 2 ? 0.6 : -0.6), py = a[1] + (b[1] - a[1]) * t + ny * (k % 2 ? 0.6 : -0.6);
              const q = hash12(k + 3, Math.round(px));
              palms.push([px, height(px, py) + hgt * ex - 0.2, -py, q * 6.283, 0.75 + q * 0.3, 0.9 + q * 0.2, q, THOTNOT]);
            }
          }
        }
      }
    };
    // canal blocks touching this tile (in the warped field frame)
    const corners = [[x0, y0], [x0 + TILE, y0], [x0, y0 + TILE], [x0 + TILE, y0 + TILE]].map(([x, y]) => fieldWarped(x, y));
    const i0 = Math.floor(Math.min(...corners.map((p) => p[0])) / BX) - 1, i1 = Math.floor(Math.max(...corners.map((p) => p[0])) / BX) + 1;
    const j0 = Math.floor(Math.min(...corners.map((p) => p[1])) / BY) - 1, j1 = Math.floor(Math.max(...corners.map((p) => p[1])) / BY) + 1;
    // a line in block (I, J) at `across` (strip boundary) or `along` (field boundary); local coords -> world
    const line = (I, J, L, acr0, alo0, acr1, alo1) => {
      const len = Math.hypot(acr1 - acr0, alo1 - alo0), n = Math.max(1, Math.ceil(len / STEP)), pts = [];
      for (let i = 0; i <= n; i++) {
        const acr = acr0 + (acr1 - acr0) * i / n, alo = alo0 + (alo1 - alo0) * i / n;
        const [lu, lv] = L.cols ? [acr, alo] : [alo, acr];
        pts.push(fieldWorld(I * BX + lu, J * BY + lv));
      }
      return pts;
    };
    for (let I = i0; I <= i1; I++) for (let J = j0; J <= j1; J++) {
      const L = blockLayout(I, J);
      for (let k = 1; k < L.n; k++) ridge(line(I, J, L, k * L.sw, 1.5, k * L.sw, L.B - 1.5), .5, 1.3, FIELD.bundHeight);
      for (let p = 1; p < L.parts; p++) ridge(line(I, J, L, 1.5, p * L.pl, L.A - 1.5, p * L.pl), .5, 1.3, FIELD.bundHeight);
      // dykes on the block's lower u and lower v edges (each edge built once)
      ridge(Array.from({ length: Math.ceil(BY / STEP) + 1 }, (_, i) => fieldWorld(I * BX, J * BY + Math.min(i * STEP, BY))), 1.2, 2.6, FIELD.dykeHeight);
      ridge(Array.from({ length: Math.ceil(BX / STEP) + 1 }, (_, i) => fieldWorld(I * BX + Math.min(i * STEP, BX), J * BY)), 1.2, 2.6, FIELD.dykeHeight);
    }
    const group = new THREE.Group();
    if (positions.length) {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices); geo.computeVertexNormals(); geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.material); mesh.raycast = () => {};
      group.add(mesh);
    }
    if (palms.length) {
      const g = height(x0 + TILE / 2, y0 + TILE / 2);
      const sphere = new THREE.Sphere(new THREE.Vector3(x0 + TILE / 2, g + 8, -(y0 + TILE / 2)), TILE * 0.75 + 30);
      group.add(this.trees.mesh(this.trees.models[THOTNOT], palms, this.trees.matNear, { cx: x0 + TILE / 2, ground: g, cz: -(y0 + TILE / 2) }, sphere));
    }
    this.group.add(group);
    return { mesh: group, used: this.frame };
  }

  dispose(entry) {
    this.group.remove(entry.mesh);
    entry.mesh.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry.isInstancedBufferGeometry) {                 // tree mesh: shared model attributes
        for (const k of ['position', 'normal', 'uv', 'aPart', 'aColor', 'aQuad']) o.geometry.deleteAttribute(k);
        o.geometry.index = null;
      }
      o.geometry.dispose();
    });
  }

  update(camera) {
    if (!this.group.visible || !this.surface) return;
    this.frame++;
    const p = camera.position, R = this.nearR, candidates = [];
    for (const entry of this.tiles.values()) entry.mesh.visible = false;
    for (let tx = Math.floor((p.x - R) / TILE); tx <= Math.floor((p.x + R) / TILE); tx++)
      for (let ty = Math.floor((-p.z - R) / TILE); ty <= Math.floor((-p.z + R) / TILE); ty++) {
        const x = (tx + .5) * TILE, y = (ty + .5) * TILE;
        const ground = this.terrain.heightAt(x, y) * this.terrain.ex;
        const d = Math.hypot(Math.max(Math.abs(x - p.x) - TILE / 2, 0), Math.max(Math.abs(y + p.z) - TILE / 2, 0), p.y - ground);
        if (d < R) candidates.push({ tx, ty, d });
      }
    candidates.sort((a, b) => a.d - b.d);
    let built = 0;
    for (const { tx, ty } of candidates.slice(0, MAX_TILES)) {
      const key = `${tx}_${ty}`; let entry = this.tiles.get(key);
      if (!entry && built < 1) { entry = this.build(tx, ty); this.tiles.set(key, entry); built++; }
      if (entry) { entry.mesh.visible = true; entry.used = this.frame; }
    }
    if (this.tiles.size > MAX_TILES) {
      const old = [...this.tiles.entries()].filter(([, t]) => !t.mesh.visible).sort((a, b) => a[1].used - b[1].used);
      for (const [key, t] of old.slice(0, this.tiles.size - MAX_TILES)) { this.dispose(t); this.tiles.delete(key); }
    }
  }
}
