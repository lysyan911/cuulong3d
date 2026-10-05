// Town street life along the 3D roads (roads3d.js builds one set per terrain tile together with the ribbons):
//   concrete power poles (cột điện) with sagging power lines and bundles of telecom cables (also along country
//   roads), street lamps on main roads,
//   street trees (the shade-tree models of trees.js), parked motorbikes in front of the shops, and pavement food stalls
//   (cart, umbrella, plastic stools); traffic lights at main-road junctions (crossings: roads3d.js); traffic: motorbike
//   riders, cars, 16-seat vans, small trucks and coaches (keeping right), cars parked at the kerb of wide streets;
//   dual carriageways: double-arm lamps and areca palms in the median, red-white posts with a keep-right sign at its
//   ends, one-way traffic. Dense bundles of telecom cables along the poles and drops to the houses.
// Placement is rule-based and stable (hashed from the road geometry), not surveyed; the traffic stands still.
// Everything is instanced; instances beyond their show range collapse in the vertex shader.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLOBALS } from './render/globals.js';
import { cloudUniforms, patchCloudShadow } from './render/atmosphere.js';

const SHOW_R = 900;
const CAR_R = 550, RIDER_R = 380;                       // traffic: smaller, so shown less far
const CELL = 300;                                        // m, culling cells
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
const GLASS = [0.07, 0.09, 0.11], TYRE = [0.04, 0.04, 0.04];
const SHIRT = [1, 0, 1], HELMET = [0, 1, 1];            // marker colours, replaced per instance in the shader
const tyres = (r, x, zs, w = 0.22) => zs.flatMap((z) => [-x, x].map((xx) => part(cyl(r, r, w, 6), TYRE, xx, r, z, 0, Math.PI / 2)));

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
  // traffic (front +z). White parts take the instance colour (paint).
  const car = mergeGeometries([
    part(box(1.76, 0.6, 4.35), WHITE, 0, 0.62, 0),
    part(box(1.58, 0.52, 2.15), GLASS, 0, 1.17, -0.25),
    part(box(1.5, 0.07, 1.85), WHITE, 0, 1.46, -0.3),
    part(box(1.4, 0.12, 0.05), [0.95, 0.93, 0.85], 0, 0.78, 2.18),
    part(box(1.5, 0.12, 0.05), [0.55, 0.04, 0.03], 0, 0.82, -2.18),
    ...tyres(0.31, 0.76, [-1.35, 1.35]),
  ]);
  const van = mergeGeometries([                             // 16-seat minibus (xe 16 chỗ)
    part(box(1.95, 1.75, 5.6), WHITE, 0, 1.25, 0),
    part(box(1.97, 0.55, 4.0), GLASS, 0, 1.62, -0.45),
    part(box(1.8, 0.62, 0.05), GLASS, 0, 1.55, 2.81),
    part(box(1.6, 0.12, 0.05), [0.95, 0.93, 0.85], 0, 0.75, 2.82),
    ...tyres(0.36, 0.86, [-1.75, 1.85]),
  ]);
  const truck = mergeGeometries([                           // small cargo truck: cab + box body
    part(box(1.95, 1.55, 1.6), WHITE, 0, 1.3, 2.3),
    part(box(1.8, 0.65, 0.05), GLASS, 0, 1.68, 3.11),
    part(box(2.1, 2.0, 4.3), [0.72, 0.72, 0.7], 0, 1.65, -0.85),
    part(box(1.0, 0.3, 6.2), DARK, 0, 0.55, 0),
    ...tyres(0.42, 0.85, [-2.1, 2.2], 0.3),
  ]);
  const bus = mergeGeometries([                             // coach (xe khách)
    part(box(2.5, 2.7, 11.6), WHITE, 0, 1.85, 0),
    part(box(2.52, 0.95, 9.6), GLASS, 0, 2.3, -0.5),
    part(box(2.3, 1.35, 0.05), GLASS, 0, 2.1, 5.81),
    part(box(2.0, 0.15, 0.05), [0.95, 0.93, 0.85], 0, 0.85, 5.82),
    part(box(2.52, 0.2, 11.62), [0.15, 0.15, 0.16], 0, 0.6, 0),
    ...tyres(0.5, 1.05, [-3.6, 3.9], 0.32),
  ]);
  // motorbike rider: bike paint = instance colour, shirt and helmet colours picked per rider in the shader
  const rWheel = (z) => part(cyl(0.29, 0.29, 0.1, 6), DARK, 0, 0.29, z, 0, Math.PI / 2);
  const rider = mergeGeometries([
    rWheel(-0.66), rWheel(0.66),
    part(box(0.3, 0.32, 0.95), WHITE, 0, 0.56, -0.05),
    part(box(0.4, 0.55, 0.1), WHITE, 0, 0.66, 0.5),
    part(box(0.34, 0.24, 0.62), [0.13, 0.13, 0.17], 0, 0.86, -0.1),           // legs
    part(box(0.4, 0.56, 0.26), SHIRT, 0, 1.24, -0.22),
    part(box(0.5, 0.1, 0.42), SHIRT, 0, 1.25, 0.12),                          // arms to the handlebar
    part(box(0.27, 0.27, 0.3), HELMET, 0, 1.66, -0.16),
  ]);
  // traffic light: pole on the kerb, mast over the road (local +x), lights facing the oncoming traffic (+z)
  const head = (x, y, z = 0) => [part(box(0.36, 1.0, 0.26), DARK, x, y, z),
    part(box(0.2, 0.2, 0.04), [0.95, 0.12, 0.06], x, y + 0.31, z + 0.14),
    part(box(0.2, 0.2, 0.04), [0.3, 0.22, 0.04], x, y, z + 0.14),
    part(box(0.2, 0.2, 0.04), [0.04, 0.2, 0.08], x, y - 0.31, z + 0.14)];
  const signal = mergeGeometries([
    part(cyl(0.09, 0.12, 6.0, 6), [0.6, 0.6, 0.58], 0, 3.0),
    part(box(4.2, 0.1, 0.1), [0.6, 0.6, 0.58], 2.1, 5.8),
    ...head(3.4, 5.25), ...head(0, 2.9, 0.18),
    part(box(0.5, 0.36, 0.08), DARK, 2.3, 5.45, 0.06),                      // countdown display
  ]);
  // median lamp: tall pole, an arm to each carriageway
  const lamp2 = mergeGeometries([
    part(cyl(0.09, 0.16, 10.0, 6), STEEL, 0, 5.0),
    part(box(0.35, 0.6, 0.35), [0.5, 0.5, 0.48], 0, 0.3),
    ...[-1, 1].flatMap((sx) => [part(box(1.8, 0.07, 0.07), STEEL, sx * 0.9, 9.85),
                                part(box(0.62, 0.12, 0.28), [0.85, 0.85, 0.8], sx * 1.8, 9.8)]),
  ]);
  // median nose: red and white striped post, blue keep-right sign facing +z
  const nose = mergeGeometries([
    ...Array.from({ length: 6 }, (_, i) => part(cyl(0.05, 0.05, 0.4, 6), i % 2 ? [0.95, 0.95, 0.93] : [0.75, 0.08, 0.06], 0, 0.2 + i * 0.4)),
    part(cyl(0.36, 0.36, 0.03, 14), [0.1, 0.3, 0.75], 0, 2.65, 0.06, Math.PI / 2),
    part(box(0.08, 0.32, 0.02), [0.95, 0.95, 0.95], 0.02, 2.62, 0.085, 0, -0.6),
    part(box(0.18, 0.06, 0.02), [0.95, 0.95, 0.95], 0.1, 2.5, 0.085, 0, 0.3),
  ]);
  return { pole, lamp, bike, stall, car, van, truck, bus, rider, signal, lamp2, nose };
}
const RANGE = { car: CAR_R, van: CAR_R, truck: CAR_R, bus: CAR_R, rider: RIDER_R };
const MEDIAN_H = 0.22, ARECA = 3;                       // (roads3d.js median kerb; trees.js species)

function material(showR = SHOW_R) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uViewPos = GLOBALS.uViewPos;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nuniform vec3 uViewPos;`)
      // white parts take the instance colour (paint); marker colours: shirt / helmet picked per instance; rest as is
      .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vColor.xyz = color.xyz;
          if (min(color.r, min(color.g, color.b)) > 0.99) vColor.xyz = instanceColor.xyz;
          else if (color.r > 0.99 && color.b > 0.99 && color.g < 0.01) {
            float k = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
            vColor.xyz = k < 0.2 ? vec3(0.92, 0.92, 0.9) : k < 0.35 ? vec3(0.45, 0.6, 0.85) : k < 0.48 ? vec3(0.85, 0.5, 0.58)
                       : k < 0.6 ? vec3(0.62, 0.55, 0.38) : k < 0.75 ? vec3(0.16, 0.2, 0.32) : k < 0.87 ? vec3(0.45, 0.46, 0.48) : vec3(0.8, 0.66, 0.3);
          } else if (color.r < 0.01 && color.g > 0.99 && color.b > 0.99) {
            float k = fract(sin(dot(instanceMatrix[3].xz, vec2(39.346, 11.135))) * 24634.6345);
            vColor.xyz = k < 0.3 ? vec3(0.9, 0.9, 0.88) : k < 0.5 ? vec3(0.65, 0.1, 0.08) : k < 0.7 ? vec3(0.1, 0.18, 0.45) : k < 0.85 ? vec3(0.08) : vec3(0.85, 0.7, 0.15);
          }
        #endif`)
      .replace('#include <project_vertex>', `
        if (distance(uViewPos, (modelMatrix * instanceMatrix[3]).xyz) > ${showR.toFixed(1)}) transformed = vec3(0.0);
        #include <project_vertex>`);
    patchCloudShadow(sh, cloudUniforms());
  };
  mat.customProgramCacheKey = () => 'cuulong-streets-' + showR;
  return mat;
}

const hashOf = (a, b) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const BIKE_COLOURS = [[0.75, 0.08, 0.07], [0.08, 0.08, 0.09], [0.85, 0.85, 0.85], [0.15, 0.25, 0.6], [0.5, 0.5, 0.52], [0.6, 0.12, 0.1]];
const UMBRELLA_COLOURS = [[0.8, 0.12, 0.1], [0.15, 0.35, 0.75], [0.2, 0.55, 0.3], [0.9, 0.75, 0.2], [0.9, 0.9, 0.88]];
const CAR_COLOURS = [[0.85, 0.85, 0.84], [0.85, 0.85, 0.84], [0.55, 0.56, 0.57], [0.06, 0.06, 0.07], [0.5, 0.07, 0.06],
                     [0.12, 0.2, 0.42], [0.3, 0.31, 0.32]];
const VAN_COLOURS = [[0.86, 0.86, 0.85], [0.86, 0.86, 0.85], [0.6, 0.61, 0.62]];
const CAB_COLOURS = [[0.15, 0.3, 0.65], [0.85, 0.85, 0.84], [0.8, 0.62, 0.12], [0.55, 0.1, 0.08]];
const BUS_COLOURS = [[0.85, 0.42, 0.1], [0.86, 0.86, 0.85], [0.15, 0.45, 0.3], [0.2, 0.35, 0.7]];
const BIKE_PAINT = [[0.62, 0.08, 0.07], [0.07, 0.07, 0.08], [0.7, 0.7, 0.72], [0.12, 0.22, 0.55], [0.85, 0.85, 0.85], [0.35, 0.36, 0.38]];

export class StreetFurniture {
  constructor(trees, { traffic = true } = {}) {
    this.traffic = traffic;                                // phones: no traffic
    this.trees = trees;
    this.models = models();
    this.material = material();
    this.mats = { [SHOW_R]: this.material, [CAR_R]: material(CAR_R), [RIDER_R]: material(RIDER_R) };
    this.wireMat = new THREE.LineBasicMaterial({ color: 0x0b0b0c, transparent: true, opacity: 0.85 });
    this.group = new THREE.Group();
    this.group.name = 'streets';
  }

  /**
   * roads: town streets of one tile, each { P: [[x, north]...], S: along (m), N: unit normals, hw, sh (sidewalk m),
   * cl (class), y: sidewalk heights }. Returns a Group (or null).
   */
  build(...args) { const g = this.buildSteps(...args); let r; while (!(r = g.next()).done); return r.value; }

  // built in steps (roads3d.js spreads a town tile over a few frames)
  *buildSteps(roads, sphere, signals = []) {
    const M = { pole: [], lamp: [], bike: [], stall: [], signal: [], car: [], van: [], truck: [], bus: [], rider: [], lamp2: [], nose: [] };
    const C = { bike: [], stall: [], car: [], van: [], truck: [], bus: [], rider: [] }, trees = [], wire = [];
    const at = (R, s) => {                                   // point, normal, height at distance s along a road
      let i = 1;
      while (i < R.S.length - 1 && R.S[i] < s) i++;
      const t = (s - R.S[i - 1]) / Math.max(R.S[i] - R.S[i - 1], 1e-6);
      const a = R.P[i - 1], b = R.P[i];
      const d = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(...d) || 1;
      const ry = R.ry || R.y;
      return { x: a[0] + d[0] * t, yN: a[1] + d[1] * t, y: R.y[i - 1] + (R.y[i] - R.y[i - 1]) * t,
               ry: ry[i - 1] + (ry[i] - ry[i - 1]) * t,
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
    // a vehicle on the road surface: sd -1 = right of the road direction (driving along it), +1 = the opposite lane
    const PAL = { car: CAR_COLOURS, van: VAN_COLOURS, truck: CAB_COLOURS, bus: BUS_COLOURS, rider: BIKE_PAINT };
    let oneway = false;                                     // one-way roads: both lanes go along the road
    const vehicle = (kind, q, off, sd, jit, r) => {
      const m = place(q, off, sd, (sd > 0 && !oneway ? Math.PI : 0) + jit);
      m.elements[13] = q.ry;
      M[kind].push(m);
      C[kind].push(PAL[kind][Math.floor(r * PAL[kind].length)]);
    };
    for (const S of signals) {
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(-S.nx, 0, S.ny), new THREE.Vector3(0, 1, 0), new THREE.Vector3(S.ux, 0, -S.uy));
      m.setPosition(S.x, S.y, -S.yN);
      M.signal.push(m);
    }
    let nRoad = 0;
    for (const R of roads) {
      yield;
      const L = R.S[R.S.length - 1];
      if (L < 18 || R.cl > 6) continue;
      const k0 = Math.round(R.P[0][0] * 3.1) * 7919 + Math.round(R.P[0][1] * 2.3);
      const h = (i, j) => hashOf(k0 + i * 131, j);
      const main = R.cl <= 4, wide = R.sh >= 2, Md = R.median, sides = Md ? [-1] : [-1, 1];  // (dual: no sidewalk on the left)
      oneway = R.oneway;
      // power poles on one side, cables between them (country roads: on the shoulder, further apart)
      const ps = Md ? -1 : h(1, 1) < 0.5 ? 1 : -1, sp = R.rural ? 42 + h(1, 2) * 10 : 34 + h(1, 2) * 8;
      const nearJ = (s) => R.J && R.J.some(([js, rr]) => Math.abs(s - js) < rr);
      // traffic, keeping right: riders in swarms, cars, vans, trucks, coaches; parked cars at the kerb of wide streets
      const town = !R.rural, paved = R.surf === 0 || R.surf === 1;
      if (this.traffic && paved && R.hw >= 1.4) for (const sd of [-1, 1]) {
        if (R.hw < 2.2 && sd > 0 && h(21, 1) < 0.5) continue;                    // narrow lanes: one way only here
        // parked cars at the kerb of wide town streets (one side, both on the widest); moving traffic keeps clear
        const parks = town && R.surf === 0 && R.hw >= 4 && !(Md && sd > 0) && (R.hw >= 5.5 || Md || (sd > 0) === (h(39, 1) < 0.5));
        const edge = parks ? R.hw - 2.3 : R.hw - 0.3, lane = R.hw * (R.hw < 2.2 ? 0.45 : 0.55);
        const busy = town ? (main ? 0.7 : 0.3) : (R.cl <= 4 ? 0.15 : 0.05), step = 7 / busy;
        let free = -1e9;                                                         // no overlaps along the lane
        for (let s = 3 + h(22, sd + 2) * step, j = 0; s < L - 3; s += step * (0.5 + h(23, j * 3 + sd + 2)), j++) {
          if (s < free || nearJ(s)) continue;
          const r = h(24, j * 7 + sd + 2);
          const big = R.hw >= 2.4 && (R.cl <= 4 || town), cut = town ? 0.72 : 0.55;
          if (!big || r < cut) {                                                  // a few riders side by side
            const n = 1 + Math.floor(h(25, j) * (town ? 2.5 : 1.6));
            let sb = s;
            for (let b = 0; b < n && sb < L - 1; b++, sb += 1.6 + h(27, j + b) * 2) {
              const o = Math.min(edge - 0.1, Math.max(0.4, lane + (h(26, j * 5 + b) - 0.5) * R.hw * 0.6));
              vehicle('rider', at(R, sb), o, sd, (h(29, j + b) - 0.5) * 0.12, h(30, j * 5 + b));
            }
            free = sb + 1.2;
          } else {
            const t = (r - cut) / (1 - cut);
            const kind = t < 0.55 ? 'car' : t < 0.72 ? 'van' : t < 0.88 || R.cl > 3 ? 'truck' : 'bus';
            const len = { car: 4.4, van: 5.6, truck: 6.4, bus: 11.6 }[kind];
            if (s + len > L - 2 || nearJ(s + len)) continue;
            vehicle(kind, at(R, s + len / 2), Math.max(0.9, Math.min(lane, edge - 1.0)), sd, 0, h(31, j));
            free = s + len + 2;
          }
        }
        if (parks) for (let s = 6 + h(32, sd + 2) * 20, j = 0; s < L - 6; s += 25 + h(33, j) * 45, j++) {
          const n = 1 + Math.floor(h(34, j * 3 + sd + 2) * (main ? 4 : 2.5));
          for (let b = 0; b < n; b++) {
            const sb = s + b * (5.4 + h(35, j + b) * 1.2);
            if (sb > L - 4 || nearJ(sb)) break;
            vehicle(h(36, j * 9 + b) < 0.85 ? 'car' : 'van', at(R, sb), R.hw - 1.05, sd, (h(37, j + b) - 0.5) * 0.04, h(38, j * 9 + b));
          }
        }
      }
      // the median: lamps, palms and end posts (placed by one of the two carriageways)
      if (Md && Md.owner) {
        const inR = (s) => Md.ranges.some(([a, b]) => s > a + 3 && s < b - 3), mo = R.hw + Md.med;
        const onMedian = (q, off, sd, yaw) => { const m = place(q, off, sd, yaw); m.elements[13] = q.ry + MEDIAN_H; return m; };
        if (Md.med >= 0.45 && R.cl <= 4) for (let s = 10 + h(40, 1) * 12; s < L - 4; s += 32) if (inR(s)) M.lamp2.push(onMedian(at(R, s), mo, 1, 0));
        if (Md.med >= 0.9) for (let s = 4 + h(41, 1) * 6, j = 0; s < L - 3; s += 8 + h(42, j) * 7, j++) {
          if (!inR(s) || (h(43, j) > 0.75 && !R.palms)) continue;
          const q = at(R, s), x = q.x + q.nx * mo, yN = q.yN + q.ny * mo;
          trees.push([x, q.ry + MEDIAN_H - 0.1, -yN, h(44, j) * 6.283, (R.palms ? 1.25 : 0.5) + h(45, j) * 0.2, 0.9 + h(46, j) * 0.2, h(47, j), ARECA]);
        }
        for (const [s, dir] of Md.noses) M.nose.push(onMedian(at(R, s), mo - 0.45, 1, dir > 0 ? Math.PI : 0));
      }
      // wide medians (a park between the carriageways): a row of trees along each side, by each carriageway
      if (Md && Md.med >= 3) {
        const inR = (s) => Md.ranges.some(([a, b]) => s > a + 3 && s < b - 3), mo = R.hw + 1.6;
        for (let s = 5 + h(50, 1) * 5, j = 0; s < L - 3; s += 9 + h(51, j) * 4, j++) {
          if (!inR(s)) continue;
          const q = at(R, s), x = q.x + q.nx * mo, yN = q.yN + q.ny * mo;
          trees.push([x, q.ry + MEDIAN_H - 0.1, -yN, h(52, j) * 6.283, R.palms ? 1.2 + h(53, j) * 0.25 : 0.3 + h(53, j) * 0.15, 0.9 + h(54, j) * 0.2, h(55, j), R.palms ? ARECA : TREE_SPECIES]);
        }
      }
      if (R.noPoles || (R.rural && h(1, 4) < 0.25)) continue;                  // some country roads have no power line
      let prevTop = null;
      for (let s = 5 + h(1, 3) * 8; s < L - 4; s += sp) {
        const q = at(R, s), m = place(q, R.hw + (R.rural ? R.sh * 0.7 : 0.45), ps, 0, 1);
        M.pole.push(m);
        const top = [-0.75, 0, 0.75].map((dx) => new THREE.Vector3(dx, 8.45, 0).applyMatrix4(m));
        // telecom: a dense bundle in towns (fibre, TV, phone cables of several companies), a few in the country
        const nTel = R.rural ? 3 : 9;
        const tel = Array.from({ length: nTel }, (_, j) => new THREE.Vector3(-0.25 + (j % 3) * 0.25, 5.7 + Math.floor(j / 3) * 0.28, 0).applyMatrix4(m));
        const ends = [...top, ...tel];
        if (prevTop) ends.forEach((e, j) => sag(wire, prevTop[j], e, j < 3 ? 0.35 : 0.55 + 0.6 * hashOf(k0 + j, Math.round(s)), j < 3 ? 8 : 5));
        prevTop = ends;
        // service drops from the pole to the houses (towns): along this side, now and then across the street
        if (!R.rural) for (let d = 0; d < 1 + Math.floor(h(48, Math.round(s)) * 3); d++) {
          const r = h(49, Math.round(s) * 7 + d), across = !Md && r < 0.25;
          const q2 = at(R, Math.min(Math.max(s + (r - 0.5) * 18, 0), L)), off = R.hw + R.sh + 0.2, side = across ? -ps : ps;
          const end = new THREE.Vector3(q2.x + q2.nx * off * side, q2.y + 4.3 + r * 1.2, -(q2.yN + q2.ny * off * side));
          sag(wire, tel[d % nTel], end, across ? 0.5 : 0.25, across ? 5 : 3);
        }
      }
      if (R.rural) continue;
      // street lamps on main roads, on the other side
      if (main && !Md) for (let s = 12 + h(2, 1) * 10; s < L - 4; s += 30) M.lamp.push(place(at(R, s), R.hw + 0.35, -ps));
      // street trees along the outer edge of wide sidewalks
      if (wide) for (const sd of sides) for (let s = 6 + h(3, sd + 2) * 6, j = 0; s < L - 4; s += 9 + h(3, j) * 7, j++) {
        if (h(4, j * 3 + sd + 2) < (main ? 0.2 : 0.65)) continue;              // lanes: only a few trees
        const q = at(R, s), x = q.x + q.nx * (R.hw + R.sh - 0.8) * sd, yN = q.yN + q.ny * (R.hw + R.sh - 0.8) * sd;
        trees.push(R.palms ? [x, q.y - 0.2, -yN, h(5, j) * 6.283, 1.15 + h(6, j) * 0.25, 0.9 + h(7, j) * 0.2, h(8, j), ARECA]   // palm avenue
                           : [x, q.y - 0.2, -yN, h(5, j) * 6.283, (main ? 0.32 : 0.24) + h(6, j) * 0.14, 0.85 + h(7, j) * 0.3, h(8, j), TREE_SPECIES]);
      }
      // parked motorbikes in front of shops (nose to the kerb), in rows
      if (R.sh >= 1.2) for (const sd of sides) for (let s = 4 + h(9, sd + 2) * 10, j = 0; s < L - 4; s += 18 + h(10, j) * 20, j++) {
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
        const sd = Md || h(18, j) < 0.5 ? -1 : 1;
        M.stall.push(place(at(R, s), R.hw + R.sh * 0.5, sd, h(19, j) * 0.6));
        C.stall.push(UMBRELLA_COLOURS[Math.floor(h(20, j) * UMBRELLA_COLOURS.length)]);
      }
    }
    // bucket everything into CELL m cells: far cells are not drawn at all (see update), near ones are frustum-culled
    const cells = new Map();
    const cellOf = (x, z) => {
      const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      let c = cells.get(key);
      if (!c) { c = { x: (Math.floor(x / CELL) + 0.5) * CELL, z: (Math.floor(z / CELL) + 0.5) * CELL, M: {}, C: {}, wire: [], trees: [], y0: Infinity, y1: -Infinity }; cells.set(key, c); }
      return c;
    };
    for (const k of Object.keys(M)) {
      M[k].forEach((m, i) => {
        const c = cellOf(m.elements[12], m.elements[14]);
        c.y0 = Math.min(c.y0, m.elements[13]); c.y1 = Math.max(c.y1, m.elements[13]);
        (c.M[k] ||= []).push(m);
        if (C[k]) (c.C[k] ||= []).push(C[k][i]);
      });
      yield;
    }
    for (let i = 0; i < wire.length; i += 6) {
      if (i % 12000 === 11994) yield;
      const c = cellOf(wire[i], wire[i + 2]);
      c.wire.push(wire[i], wire[i + 1], wire[i + 2], wire[i + 3], wire[i + 4], wire[i + 5]);
      c.y0 = Math.min(c.y0, wire[i + 1] - 10, wire[i + 4] - 10); c.y1 = Math.max(c.y1, wire[i + 1], wire[i + 4]);
    }
    for (const t of trees) { const c = cellOf(t[0], t[2]); c.trees.push(t); c.y0 = Math.min(c.y0, t[1]); c.y1 = Math.max(c.y1, t[1]); }
    const g = new THREE.Group();
    let nCell = 0;
    yield;
    for (const c of cells.values()) {
      yield;
      const cg = new THREE.Group();
      const y = sphere.center.y;
      const cs = new THREE.Sphere(new THREE.Vector3(c.x, y, c.z), CELL * 0.75 + 30);
      cg.userData.cell = cs;
      const m = CELL / 2 + 25;                              // (wires and tree crowns reach a little out of the cell)
      cg.userData.occBox = new THREE.Box3(new THREE.Vector3(c.x - m, c.y0 - 2, c.z - m), new THREE.Vector3(c.x + m, c.y1 + 20, c.z + m));
      const subs = {};                                     // traffic: own groups, hidden sooner
      for (const k of Object.keys(c.M)) {
        const mesh = new THREE.InstancedMesh(this.models[k], this.mats[RANGE[k] || SHOW_R], c.M[k].length);
        c.M[k].forEach((m, i) => mesh.setMatrixAt(i, m));
        if (c.C[k]) c.C[k].forEach((col, i) => mesh.setColorAt(i, new THREE.Color(...col)));
        mesh.boundingSphere = cs.clone();
        mesh.computeBoundingSphere = () => {};
        mesh.raycast = () => {};
        const r = RANGE[k];
        if (r) { if (!subs[r]) { subs[r] = new THREE.Group(); subs[r].userData.range = r; cg.add(subs[r]); } subs[r].add(mesh); }
        else cg.add(mesh);
      }
      cg.userData.subs = Object.values(subs);
      if (c.wire.length) {
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', new THREE.Float32BufferAttribute(c.wire, 3));
        wg.boundingSphere = cs.clone();
        const lines = new THREE.LineSegments(wg, this.wireMat);
        lines.userData.noShadow = true;
        lines.userData.faunaCable = true; // fauna reads the existing sagged cable vertices only
        cg.add(lines);
      }
      if (c.trees.length && this.trees) {
        const T = { cx: c.x, ground: y, cz: c.z };
        this.trees.treeChunk(cg, this.trees.models.map((_, sp) => c.trees.filter(t => t[7] === sp)), T, cs.clone());
        this.trees.closePosition.set(Infinity, Infinity, Infinity);
      }
      g.add(cg);
    }
    return g.children.length ? g : null;
  }

  /** Show only the cells near the viewer (call every frame or so). */
  update(g, p) {
    for (const cg of g.children) {
      const c = cg.userData.cell.center;
      const d = Math.hypot(c.x - p.x, c.z - p.z, Math.max(p.y - c.y, 0));
      cg.visible = d < SHOW_R + CELL * 0.7;
      if (cg.visible) for (const sg of cg.userData.subs) sg.visible = d < sg.userData.range + CELL * 0.7;
    }
  }

  dispose(g) {
    if (!g) return;
    this.group.remove(g);
    // Tree pools retain original records; drop street-cell registrations before disposing their GPU buffers.
    if (this.trees) for (const cg of g.children) this.trees.closeChunks.delete(cg);
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

// a sagging cable from a to b as n line segments
function sag(out, a, b, depth, n = 8) {
  let p = a;
  for (let i = 1; i <= n; i++) {
    const t = i / n, q = a.clone().lerp(b, t);
    q.y -= depth * 4 * t * (1 - t);
    out.push(p.x, p.y, p.z, q.x, q.y, q.z);
    p = q;
  }
}
