// Hand-made Blender models (web/models/*.glb) placed into the map:
//   detailed houses  near the camera (~300 m), matching generated houses are swapped for a real model fitted to
//                    the same footprint and heading: tube house / urban shop house, stilt house, rural timber house
//   landmarks        models standing on their real building (props.json), e.g. UBND TP Long Xuyên
//   boats            cargo boats, covered cargo boats, floating shop boats and sampans sailing and moored along the
//                    real rivers and canals (inst/water_*.bin), sized to each waterway, bobbing on the water
// Models load the first time they are needed. Each model is merged per material and drawn instanced.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OCC_SOURCES } from './render/occlusion.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { metricUVs, modelPhotoMaterial } from './photo-textures.js';

const MODELS = 'models/';
// footprint (m): x = across the front, z = front to back (from the model manifests)
const HOUSE = {
  'modern-tube-house': { x: 4.8, z: 12 },
  'urban-shophouse': { x: 4.6, z: 10.5 },
  'traditional-cham-stilt': { x: 7.2, z: 8.4 },
  'traditional-rural-timber': { x: 12, z: 8.2 },
};
const LANDMARK = {
  'long-xuyen-civic-office': { x: 36, z: 15 },
  'long-xuyen-cathedral': { x: 32.48, z: 64.48, trueScale: true, lod: 'long-xuyen-cathedral-lod' },
  'long-xuyen-round-annex': { x: 32, z: 40, trueScale: true, authoredUV: true, lod: 'long-xuyen-round-annex-lod' },
  'long-xuyen-hoang-dieu-bridge': { x: 23, z: 188.45, trueScale: true, authoredUV: true, lod: 'long-xuyen-hoang-dieu-bridge-lod' },
  'long-xuyen-nguyen-hue-island': { x: 19, z: 30, trueScale: true, authoredUV: true, lod: 'long-xuyen-nguyen-hue-island-lod' },
  'long-xuyen-coopmart': { x: 34.837, z: 44.066, trueScale: true, authoredUV: true, lod: 'long-xuyen-coopmart-lod' },
  'long-xuyen-canal-courtyard': { x: 217.16, z: 175.70, trueScale: true, authoredUV: true, lod: 'long-xuyen-canal-courtyard-lod' },
};
const authoredMaps = id => id.startsWith('long-xuyen-cathedral') || LANDMARK[id.replace(/-lod$/, '')]?.authoredUV;
const BOAT = {   // length, beam, speed (m/s)
  'open-cargo-boat': { L: 17, B: 4.8, v: 3.2 },
  'covered-cargo-boat': { L: 21, B: 5.6, v: 3.0 },
  'floating-shop-boat': { L: 8.3, B: 2.8, v: 1.4 },
  'blue-passenger-sampan': { L: 5.2, B: 1.8, v: 1.0 },
};

// ---------------------------------------------------------------- model library
class Library {
  constructor() { this.loader = new GLTFLoader(); this.models = new Map(); this.surfaceMaps = new Map(); }
  /** Returns the model if loaded, else starts loading it and returns null. */
  get(id) {
    const m = this.models.get(id);
    if (m) return m.ready ? m : null;
    const entry = { ready: false };
    this.models.set(id, entry);
    this.loader.loadAsync(`${MODELS}${id}.glb`).then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const byMat = new Map();
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const original = o.geometry.clone().applyMatrix4(o.matrixWorld);
        // Authored landmarks have baked metric UVs; preserve them and embedded maps.
        const g = authoredMaps(id) ? original : metricUVs(original);
        if (g !== original) original.dispose();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
        if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const mat = mats[0];
        if (!byMat.has(mat.uuid)) byMat.set(mat.uuid, { mat, geos: [] });
        byMat.get(mat.uuid).geos.push(g);
      });
      entry.parts = [...byMat.values()].map(({ mat, geos }) => {
        mat.side = THREE.FrontSide;
        // Full and far authored exports use identical baked maps: upload each only once.
        if (authoredMaps(id) && mat.map) {
          const shared = this.surfaceMaps.get(mat.name);
          if (shared) { const redundant = mat.map; mat.map = shared; redundant.dispose(); }
          else this.surfaceMaps.set(mat.name, mat.map);
        }
        const geometry = mergeGeometries(geos); geos.forEach(g => g.dispose());
        return { geometry, material: modelPhotoMaterial(mat, id) };
      });
      entry.ready = true;
    }).catch((e) => { console.warn('model', id, e); entry.failed = true; });
    return null;
  }
}

/** One model drawn many times: an InstancedMesh per material. occlude: each copy may be hidden by occlusion culling. */
class Instanced {
  constructor(model, cap, parent, occlude = false) {
    this.meshes = model.parts.map(({ geometry, material }) => {
      const m = new THREE.InstancedMesh(geometry, material, cap);
      m.frustumCulled = false;
      m.count = 0;
      m.raycast = () => {};
      parent.add(m);
      return m;
    });
    this.cap = cap;
    if (occlude) {
      this.occ = { version: 0, items: [] };
      OCC_SOURCES.push(this.occ);
      this.box = new THREE.Box3();
      for (const m of this.meshes) { m.geometry.computeBoundingBox(); this.box.union(m.geometry.boundingBox); }
    }
  }
  set(matrices) {
    const n = Math.min(matrices.length, this.cap);
    for (const m of this.meshes) {
      for (let i = 0; i < n; i++) m.setMatrixAt(i, matrices[i]);
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
    if (!this.occ) return;
    const ver = ++this.occ.version, shown = () => { for (let o = this.meshes[0]; o; o = o.parent) if (!o.visible) return false; return true; };
    const list = matrices.slice(0, n), off = list.map(() => false);
    this.occ.items = list.map((mx, i) => ({
      box: this.box.clone().applyMatrix4(mx).expandByScalar(1.5), shown,   // (padded: a box flush with a flat deck fails its own depth test)
      setHidden: (h) => {
        if (this.occ.version !== ver || off[i] === h) return;      // the copies have been re-placed since
        off[i] = h;
        const keep = list.filter((_, k) => !off[k]);               // occluded copies are not drawn at all
        for (const m of this.meshes) {
          keep.forEach((x, k) => m.setMatrixAt(k, x));
          m.count = keep.length;
          m.instanceMatrix.needsUpdate = true;
        }
      },
    }));
  }
}

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
/** Matrix for a model whose front (+Z) faces direction theta (radians, east = 0, north = +pi/2). */
function placed(x, y, z, theta, sx, sy, sz, extraYaw = 0, roll = 0) {
  _e.set(0, Math.atan2(Math.cos(theta), -Math.sin(theta)) + extraYaw, roll, 'YXZ');
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(sx, sy, sz));
}
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

// ---------------------------------------------------------------- props layer
export class PropsLayer {
  constructor(meta, terrain, houses, shared, { heroR = 300, boatR = 2500, heroCap = 40, boatCap = 160 } = {}) {
    this.meta = meta;
    this.terrain = terrain;
    this.houses = houses;
    this.shared = shared;
    this.heroR = heroR;
    this.boatR = boatR;
    this.heroCap = heroCap;
    this.boatCap = boatCap;
    this.lib = new Library();
    this.group = new THREE.Group();          // detailed houses + landmarks (Buildings layer)
    this.group.name = 'props';
    this.boatGroup = new THREE.Group();      // boats (Boats layer)
    this.boatGroup.name = 'boats';
    this.inst = new Map();
    this.hidden = [];               // [tile, index] currently replaced by a detailed house
    this.lastPick = null;
    this.landmarks = [];
    this.lines = [];
  }

  instancer(id, cap) {
    let it = this.inst.get(id);
    if (it) return it;
    const model = this.lib.get(id);
    if (!model) return null;
    it = new Instanced(model, cap, BOAT[id] ? this.boatGroup : this.group, !BOAT[id]);
    this.inst.set(id, it);
    return it;
  }

  // ---- landmarks (props.json): hide the generated houses under them right away
  setLandmarks(list) {
    const ex = this.meta.vert_exag;
    for (const L of list) {
      const spec = LANDMARK[L.model];
      if (!spec) continue;
      const x = L.x, z = -L.y;
      // Bridge origin uses bank ground; its authored piers extend below ground into the water.
      const samples = L.groundAt || [[L.x, L.y]];
      const y = Math.max(...samples.map(([east, north]) => this.terrain.heightAt(east, north))) * ex;
      const sx = L.width / spec.x, sz = L.depth / spec.z, sy = spec.trueScale ? 1 : clamp(Math.sqrt(sx * sz) * 0.75, 0.9, 1.25);
      // the front faces `front`; the long side runs across it
      const along = L.front + Math.PI / 2;
      const hx = x + Math.cos(L.front) * (L.hideFront || 0), hz = z - Math.sin(L.front) * (L.hideFront || 0);
      if (L.hideRects) {
        for (const r of L.hideRects) this.houses.hideInRect(r.x, -r.y, -(r.front + Math.PI / 2), r.width / 2, r.depth / 2);
      } else this.houses.hideInRect(hx, hz, -along, (L.hideWidth || L.width + 12) / 2, (L.hideDepth || L.depth + 12) / 2);
      this.landmarks.push({ id: L.model, x, z, matrix: placed(x, y, z, L.front, spec.trueScale ? 1 : sx, sy, spec.trueScale ? 1 : sz) });
    }
  }

  // ---- waterways for boats
  async loadCell(gx, gy, url) {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    const dv = new DataView(buf);
    const n = dv.getInt32(0, true), nPts = dv.getInt32(4, true);
    let o = 8;
    const npts = new Uint16Array(buf, o, n); o += n * 2;
    const kind = new Uint8Array(buf, o, n); o += n;
    o += (4 - (o % 4)) % 4;
    const xy = new Int32Array(buf, o, nPts * 2); o += nPts * 8;
    const hw = new Uint8Array(buf, o, nPts);
    let s0 = 0;
    for (let i = 0; i < n; i++) {
      const P = [], W = [], S = [0];
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let k = 0; k < npts[i]; k++) {
        const x = xy[(s0 + k) * 2] / 10, z = -xy[(s0 + k) * 2 + 1] / 10;
        P.push(x, z); W.push(hw[s0 + k]);
        if (k) S.push(S[k - 1] + Math.hypot(x - P[(k - 1) * 2], z - P[(k - 1) * 2 + 1]));
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      s0 += npts[i];
      const line = { P, W, S, L: S[S.length - 1], kind: kind[i], box: [minX, maxX, minZ, maxZ], boats: null };
      this.lines.push(line);
    }
  }

  spawn(line, seed) {
    let h = seed >>> 0;
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9 >>> 0) / 4294967296);
    const medW = line.W[line.W.length >> 1];
    const big = line.kind === 0 || medW > 60;
    const spacing = big ? 650 : 420;
    const boats = [];
    for (let s = rnd() * spacing; s < line.L; s += spacing * (0.5 + rnd())) {
      const r = rnd();
      const id = big ? (r < 0.38 ? 'open-cargo-boat' : r < 0.76 ? 'covered-cargo-boat' : r < 0.86 ? 'floating-shop-boat' : 'blue-passenger-sampan')
        : medW > 14 ? (r < 0.2 ? 'open-cargo-boat' : r < 0.35 ? 'covered-cargo-boat' : r < 0.65 ? 'floating-shop-boat' : 'blue-passenger-sampan')
          : (r < 0.35 ? 'floating-shop-boat' : 'blue-passenger-sampan');
      const spec = BOAT[id];
      const moored = rnd() < (big ? 0.25 : 0.5);
      boats.push({ id, s, moored, dir: rnd() < 0.5 ? 1 : -1, lane: (rnd() - 0.5) * 0.9, side: rnd() < 0.5 ? -1 : 1,
                   v: spec.v * (0.8 + rnd() * 0.4), phase: rnd() * 6.28, B: spec.B });
    }
    return boats;
  }

  // point, tangent and half width at distance s along a line
  at(line, s) {
    const S = line.S;
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
    const t = S[hi] > S[lo] ? (s - S[lo]) / (S[hi] - S[lo]) : 0;
    const P = line.P;
    const x = P[lo * 2] + (P[hi * 2] - P[lo * 2]) * t, z = P[lo * 2 + 1] + (P[hi * 2 + 1] - P[lo * 2 + 1]) * t;
    const dx = P[hi * 2] - P[lo * 2], dz = P[hi * 2 + 1] - P[lo * 2 + 1], l = Math.hypot(dx, dz) || 1;
    return [x, z, dx / l, dz / l, line.W[lo] + (line.W[hi] - line.W[lo]) * t];
  }

  updateBoats(camera) {
    const p = camera.position, t = this.shared.uTime.value, ex = this.meta.vert_exag, R = this.boatR;
    const out = {};
    for (const [li, line] of this.lines.entries()) {
      const [x0, x1, z0, z1] = line.box;
      const dx = Math.max(x0 - p.x, 0, p.x - x1), dz = Math.max(z0 - p.z, 0, p.z - z1);
      if (Math.hypot(dx, dz) > R) continue;
      line.boats ||= this.spawn(line, li * 7919 + 13);
      for (const b of line.boats) {
        let s = b.s, fade = 1;
        if (!b.moored) {
          s = ((b.s + b.dir * b.v * t) % line.L + line.L) % line.L;
          fade = Math.min(s / 60, (line.L - s) / 60, 1);                 // appear / leave at the ends of the line
          if (fade < 0.05) continue;
        }
        const [x, z, tx, tz, hw] = this.at(line, s);
        const room = hw - b.B / 2 - 1.5;
        if (room < 0) continue;                                          // too narrow here for this boat
        const off = b.moored ? b.side * room : clamp(b.lane * hw, -room, room);
        const bx = x - tz * off, bz = z + tx * off;
        if (Math.hypot(bx - p.x, bz - p.z, p.y) > R) continue;
        if (this.terrain.surface && this.terrain.surface.waterAt(bx, -bz) < 0.5) continue;
        const y = this.terrain.waterHeightAt(bx, -bz) + 0.06 * Math.sin(t * 1.4 + b.phase);
        const head = b.moored ? b.side : b.dir;
        const theta = Math.atan2(-tz * head, tx * head);                // travel direction, as east/north angle
        (out[b.id] ||= []).push(placed(bx, y, bz, theta, fade, fade, fade, 0, 0.025 * Math.sin(t * 1.1 + b.phase)));
      }
    }
    for (const id of Object.keys(BOAT)) {
      const list = out[id] || [];
      if (!list.length && !this.inst.has(id)) continue;
      const it = this.instancer(id, this.boatCap);
      if (it) it.set(list);
    }
  }

  // ---- detailed houses near the camera
  pickHouses(camera) {
    const H = this.houses, p = camera.position, R = this.heroR;
    const cand = [];
    for (const T of H.tiles) {
      if (!T.meshes || Math.hypot(T.cx - p.x, T.cz - p.z) > R + H.tileM) continue;
      const { iA, iB, iC } = T.data;
      for (const [st, start, count] of T.ranges) {
        if (st === 1 || st === 6) continue;                              // blocks and halls keep their own look
        for (let i = start; i < start + count; i++) {
          if (iC[i * 4 + 3] === 2 || iC[i * 4 + 3] === 3) continue;     // (4: a building-kit house, may be replaced)
          const d = Math.hypot(iA[i * 4] - p.x, iA[i * 4 + 1] - p.y, iA[i * 4 + 2] - p.z);
          if (d > R) continue;
          const W = iB[i * 3], D = iB[i * 3 + 1], Hh = iB[i * 3 + 2], seed = iC[i * 4 + 2];
          let id = null, rot = false;
          if (st === 0) id = Hh <= 7.6 ? 'modern-tube-house' : 'urban-shophouse';
          else if (st === 4 || st === 5) id = 'traditional-cham-stilt';
          else if (W >= 6.5 && D >= 7.5 && seed < 150) { id = 'traditional-rural-timber'; rot = true; }
          if (!id) continue;
          const f = HOUSE[id], ax = rot ? f.z : f.x, az = rot ? f.x : f.z;
          const rW = W / ax, rD = D / az;
          if (rW < 0.6 || rW > 1.6 || rD < 0.6 || rD > 1.6) continue;
          cand.push({ T, i, d, id, rot, rW, rD, seed });
        }
      }
    }
    cand.sort((a, b) => a.d - b.d);
    const per = {}, pick = [];
    for (const c of cand) if ((per[c.id] = (per[c.id] || 0) + 1) <= this.heroCap) pick.push(c);
    // swap: show the old ones again, hide the new ones
    const keep = new Set(pick.map((c) => c.T.cx + ':' + c.T.cz + ':' + c.i));
    for (const [T, i] of this.hidden) if (!keep.has(T.cx + ':' + T.cz + ':' + i)) H.setHidden(T, i, 0);
    this.hidden = pick.map((c) => [c.T, c.i]);
    const mats = {};
    for (const c of pick) {
      H.setHidden(c.T, c.i, 1);
      const { iA } = c.T.data, i = c.i;
      const s = Math.sqrt(c.rW * c.rD);
      const fx = clamp(c.rot ? c.rD : c.rW, 0.85 * s, 1.15 * s), fz = clamp(c.rot ? c.rW : c.rD, 0.85 * s, 1.15 * s);
      const yaw = c.rot ? (c.seed & 1 ? 1 : -1) * Math.PI / 2 : 0;
      (mats[c.id] ||= []).push(placed(iA[i * 4], iA[i * 4 + 1] + 0.3, iA[i * 4 + 2], iA[i * 4 + 3], fx, clamp(s, 0.85, 1.15), fz, yaw));
    }
    for (const id of Object.keys(HOUSE)) {
      if (!mats[id] && !this.inst.has(id)) continue;
      const it = this.instancer(id, this.heroCap);
      if (it) it.set(mats[id] || []);
      else if (mats[id]) this.lastPick = null;                           // model still loading: try again soon
    }
  }

  update(camera) {
    const p = camera.position;
    if (this.group.visible) this.updateHouses(camera, p);
    if (this.boatGroup.visible) this.updateBoats(camera);
  }

  updateHouses(camera, p) {
    // detailed houses: re-pick when the camera has moved or every ~half second
    this.frame = (this.frame || 0) + 1;
    if (!this.lastPick || this.lastPick.distanceTo(p) > 20 || this.frame % 30 === 0) {
      this.pickHouses(camera);
      this.lastPick ||= new THREE.Vector3();
      this.lastPick.copy(p);
    }
    for (const L of this.landmarks) {
      const spec = LANDMARK[L.id], d = Math.hypot(L.x - p.x, L.z - p.z, p.y - L.matrix.elements[13]);
      if (!spec.lod) {
        if (L.shown || d > 5000) continue;
        const it = this.instancer(L.id, 1);
        if (it) { it.set([L.matrix]); L.shown = true; }
        continue;
      }
      // Hysteresis avoids repeated swaps near the LOD boundary; hidden versions draw zero instances.
      const want = d > 5000 ? null : d < 800 ? L.id : d > 1000 ? spec.lod : (L.active || spec.lod);
      if (want === L.active) continue;
      const it = want && this.instancer(want, 1);
      if (want && !it) continue;   // keep the old silhouette while the next GLB loads
      if (L.active) this.inst.get(L.active)?.set([]);
      if (it) it.set([L.matrix]);
      L.active = want;
    }
  }
}
