// Town street life along the 3D roads (roads3d.js builds one set per terrain tile together with the ribbons):
//   concrete power poles (cột điện) with sagging power lines and bundles of telecom cables (also along country
//   roads), street lamps on main roads,
//   street trees (the shade-tree models of trees.js), parked motorbikes in front of the shops, and pavement food stalls
//   (cart, umbrella, plastic stools). Placement is rule-based and stable (hashed from the road geometry), not surveyed.
// Everything is instanced; instances beyond SHOW_R of the viewer collapse in the vertex shader.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLOBALS } from './render/globals.js';
import { cloudUniforms, patchCloudShadow } from './render/atmosphere.js';

const SHOW_R = 900;
const TREE_SPECIES = 1;                                  // 'shade' in trees.js

// ---------------------------------------------------------------- models (x across the road, y up, z along it)
function part(geo, color, x = 0, y = 0, z = 0, rx = 0, rz = 0) {
  const g = geo.toNonIndexed();
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  const c = new THREE.Color(...color), n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r0, r1, h, s = 6) => new THREE.CylinderGeometry(r0, r1, h, s, 1);
const CONCRETE = [0.55, 0.54, 0.51], DARK = [0.05, 0.05, 0.055], WHITE = [1, 1, 1], STEEL = [0.45, 0.46, 0.47];

function models() {
  const pole = mergeGeometries([
    part(cyl(0.11, 0.18, 9.0, 6), CONCRETE, 0, 4.5),
    part(box(1.8, 0.12, 0.12), CONCRETE, 0, 8.3),
    ...[-0.75, 0, 0.75].map((x) => part(cyl(0.05, 0.05, 0.18, 5), [0.75, 0.75, 0.72], x, 8.45)),
    part(box(0.5, 0.12, 0.08), DARK, 0, 6.2),               // telecom cable clamp
  ]);
  const lamp = mergeGeometries([
    part(cyl(0.06, 0.1, 8.0, 6), STEEL, 0, 4.0),
    part(box(1.7, 0.07, 0.07), STEEL, -0.85, 7.85),
    part(box(0.6, 0.12, 0.28), [0.85, 0.85, 0.8], -1.75, 7.8),
  ]);
  const wheel = (z) => part(cyl(0.29, 0.29, 0.1, 10), DARK, 0, 0.29, z, 0, Math.PI / 2);
  const bike = mergeGeometries([                            // white parts take the instance colour (paint)
    wheel(-0.66), wheel(0.66),
    part(box(0.3, 0.32, 0.95), WHITE, 0, 0.56, -0.05),
    part(box(0.28, 0.1, 0.62), [0.07, 0.06, 0.06], 0, 0.8, -0.2),
    part(box(0.4, 0.55, 0.1), WHITE, 0, 0.66, 0.5),
    part(box(0.62, 0.05, 0.05), DARK, 0, 1.03, 0.55),
    part(box(0.14, 0.1, 0.06), [0.9, 0.9, 0.85], 0, 0.95, 0.6),
  ]);
  const stools = [[-0.7, 0.6], [0.7, 0.6], [-0.7, -0.6], [0.7, -0.6], [0, 1.0]].map(([x, z], i) =>
    part(box(0.3, 0.32, 0.3), i % 2 ? [0.12, 0.3, 0.7] : [0.75, 0.1, 0.08], x, 0.16, z));
  const stall = mergeGeometries([
    part(box(1.2, 0.9, 0.62), [0.78, 0.8, 0.8], 0, 0.45, -1.6),            // cart (xe đẩy) with a glass case
    part(box(1.1, 0.35, 0.55), [0.55, 0.7, 0.75], 0, 1.08, -1.6),
    part(cyl(0.025, 0.025, 2.3, 4), STEEL, 0, 1.15, 0),
    part(new THREE.ConeGeometry(1.3, 0.45, 8, 1, true), WHITE, 0, 2.35, 0),  // umbrella takes the instance colour
    part(box(0.62, 0.45, 0.62), [0.85, 0.85, 0.82], 0, 0.22, 0),
    ...stools,
  ]);
  return { pole, lamp, bike, stall };
}

function material() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uViewPos = GLOBALS.uViewPos;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nuniform vec3 uViewPos;`)
      .replace('#include <project_vertex>', `
        if (distance(uViewPos, (modelMatrix * instanceMatrix[3]).xyz) > ${SHOW_R.toFixed(1)}) transformed = vec3(0.0);
        #include <project_vertex>`);
    patchCloudShadow(sh, cloudUniforms());
  };
  mat.customProgramCacheKey = () => 'cuulong-streets';
  return mat;
}

const hashOf = (a, b) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const BIKE_COLOURS = [[0.75, 0.08, 0.07], [0.08, 0.08, 0.09], [0.85, 0.85, 0.85], [0.15, 0.25, 0.6], [0.5, 0.5, 0.52], [0.6, 0.12, 0.1]];
const UMBRELLA_COLOURS = [[0.8, 0.12, 0.1], [0.15, 0.35, 0.75], [0.2, 0.55, 0.3], [0.9, 0.75, 0.2], [0.9, 0.9, 0.88]];

export class StreetFurniture {
  constructor(trees) {
    this.trees = trees;
    this.models = models();
    this.material = material();
    this.wireMat = new THREE.LineBasicMaterial({ color: 0x0b0b0c, transparent: true, opacity: 0.85 });
    this.group = new THREE.Group();
    this.group.name = 'streets';
  }

  /**
   * roads: town streets of one tile, each { P: [[x, north]...], S: along (m), N: unit normals, hw, sh (sidewalk m),
   * cl (class), y: sidewalk heights }. Returns a Group (or null).
   */
  build(roads, sphere) {
    const M = { pole: [], lamp: [], bike: [], stall: [] }, C = { bike: [], stall: [] }, trees = [], wire = [];
    const at = (R, s) => {                                   // point, normal, height at distance s along a road
      let i = 1;
      while (i < R.S.length - 1 && R.S[i] < s) i++;
      const t = (s - R.S[i - 1]) / Math.max(R.S[i] - R.S[i - 1], 1e-6);
      const a = R.P[i - 1], b = R.P[i];
      const d = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(...d) || 1;
      return { x: a[0] + d[0] * t, yN: a[1] + d[1] * t, y: R.y[i - 1] + (R.y[i] - R.y[i - 1]) * t,
               nx: -d[1] / l, ny: d[0] / l, dx: d[0] / l, dy: d[1] / l };
    };
    // matrix with local x across the road (towards side sd), z along it; scene z = -north
    const place = (q, off, sd, yaw = 0, sc = 1, lift = 0) => {
      const x = q.x + q.nx * off * sd, yN = q.yN + q.ny * off * sd;
      const ax = new THREE.Vector3(q.nx * sd, 0, -q.ny * sd), az = new THREE.Vector3(q.dx, 0, -q.dy);
      if (yaw) { const c = Math.cos(yaw), s = Math.sin(yaw); const a2 = ax.clone().multiplyScalar(c).addScaledVector(az, -s); az.multiplyScalar(c).addScaledVector(ax, s); ax.copy(a2); }
      const m = new THREE.Matrix4().makeBasis(ax.multiplyScalar(sc), new THREE.Vector3(0, sc, 0), az.multiplyScalar(sc));
      m.setPosition(x, q.y + lift, -yN);
      return m;
    };
    for (const R of roads) {
      const L = R.S[R.S.length - 1];
      if (L < 18 || R.cl > 6) continue;
      const k0 = Math.round(R.P[0][0] * 3.1) * 7919 + Math.round(R.P[0][1] * 2.3);
      const h = (i, j) => hashOf(k0 + i * 131, j);
      const main = R.cl <= 4, wide = R.sh >= 2;
      // power poles on one side, cables between them (country roads: on the shoulder, further apart)
      const ps = h(1, 1) < 0.5 ? 1 : -1, sp = R.rural ? 42 + h(1, 2) * 10 : 34 + h(1, 2) * 8;
      if (R.rural && h(1, 4) < 0.25) continue;                                  // some country roads have none
      let prevTop = null;
      for (let s = 5 + h(1, 3) * 8; s < L - 4; s += sp) {
        const q = at(R, s), m = place(q, R.hw + (R.rural ? R.sh * 0.7 : 0.45), ps, 0, 1);
        M.pole.push(m);
        const top = [-0.75, 0, 0.75].map((dx) => new THREE.Vector3(dx, 8.45, 0).applyMatrix4(m));
        const tel = [-0.15, 0, 0.15].map((dx) => new THREE.Vector3(dx, 6.2, 0).applyMatrix4(m));
        const ends = [...top, ...tel];
        if (prevTop) ends.forEach((e, j) => sag(wire, prevTop[j], e, j < 3 ? 0.35 : 0.6 + 0.25 * (j % 2)));
        prevTop = ends;
      }
      if (R.rural) continue;
      // street lamps on main roads, on the other side
      if (main) for (let s = 12 + h(2, 1) * 10; s < L - 4; s += 30) M.lamp.push(place(at(R, s), R.hw + 0.35, -ps));
      // street trees along the outer edge of wide sidewalks
      if (wide) for (const sd of [-1, 1]) for (let s = 6 + h(3, sd + 2) * 6, j = 0; s < L - 4; s += 9 + h(3, j) * 7, j++) {
        if (h(4, j * 3 + sd + 2) < (main ? 0.35 : 0.75)) continue;              // lanes: only a few trees
        const q = at(R, s), x = q.x + q.nx * (R.hw + R.sh - 0.8) * sd, yN = q.yN + q.ny * (R.hw + R.sh - 0.8) * sd;
        trees.push([x, q.y - 0.2, -yN, h(5, j) * 6.283, (main ? 0.32 : 0.24) + h(6, j) * 0.14, 0.85 + h(7, j) * 0.3, h(8, j), TREE_SPECIES]);
      }
      // parked motorbikes in front of shops (nose to the kerb), in rows
      if (R.sh >= 1.2) for (const sd of [-1, 1]) for (let s = 4 + h(9, sd + 2) * 10, j = 0; s < L - 4; s += 18 + h(10, j) * 20, j++) {
        if (h(11, j * 5 + sd + 2) > (main ? 0.6 : 0.4)) continue;
        const n = 2 + Math.floor(h(12, j) * 6);
        for (let b = 0; b < n && s + b * 0.8 < L - 3; b++) {
          const q = at(R, s + b * 0.8), kk = j * 17 + b;
          M.bike.push(place(q, R.hw + Math.min(R.sh * 0.6, 2.4), sd, Math.PI / 2 + (h(13, kk) - 0.5) * 0.4, 1, 0));
          C.bike.push(BIKE_COLOURS[Math.floor(h(14, kk) * BIKE_COLOURS.length)]);
        }
      }
      // pavement food stalls on wide sidewalks
      if (R.sh >= 2.4) for (let s = 15 + h(15, 1) * 30, j = 0; s < L - 8; s += 45 + h(16, j) * 50, j++) {
        if (h(17, j) > 0.45) continue;
        const sd = h(18, j) < 0.5 ? 1 : -1;
        M.stall.push(place(at(R, s), R.hw + R.sh * 0.5, sd, h(19, j) * 0.6));
        C.stall.push(UMBRELLA_COLOURS[Math.floor(h(20, j) * UMBRELLA_COLOURS.length)]);
      }
    }
    const g = new THREE.Group();
    for (const k of Object.keys(M)) {
      if (!M[k].length) continue;
      const mesh = new THREE.InstancedMesh(this.models[k], this.material, M[k].length);
      M[k].forEach((m, i) => mesh.setMatrixAt(i, m));
      if (C[k]) C[k].forEach((c, i) => mesh.setColorAt(i, new THREE.Color(...c)));
      mesh.boundingSphere = sphere.clone();
      mesh.computeBoundingSphere = () => {};
      mesh.raycast = () => {};
      g.add(mesh);
    }
    if (wire.length) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
      wg.boundingSphere = sphere.clone();
      const lines = new THREE.LineSegments(wg, this.wireMat);
      lines.userData.noShadow = true;
      g.add(lines);
    }
    if (trees.length && this.trees) {
      const T = { cx: sphere.center.x, ground: sphere.center.y, cz: sphere.center.z };
      g.add(this.trees.mesh(this.trees.models[TREE_SPECIES], trees, this.trees.matNear, T, sphere.clone()));
    }
    return g.children.length ? g : null;
  }

  dispose(g) {
    if (!g) return;
    this.group.remove(g);
    g.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
      else if (o.isLineSegments) o.geometry.dispose();
      else if (o.isMesh && o.geometry.isInstancedBufferGeometry) {        // tree mesh: shared model attributes
        for (const k of ['position', 'normal', 'uv', 'aPart', 'aColor', 'aQuad']) o.geometry.deleteAttribute(k);
        o.geometry.index = null;
        o.geometry.dispose();
      }
    });
  }
}

// a sagging cable from a to b as 8 line segments
function sag(out, a, b, depth) {
  let p = a;
  for (let i = 1; i <= 8; i++) {
    const t = i / 8, q = a.clone().lerp(b, t);
    q.y -= depth * 4 * t * (1 - t);
    out.push(p.x, p.y, p.z, q.x, q.y, q.z);
    p = q;
  }
}
