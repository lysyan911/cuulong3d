// Real building footprints drawn as An Giang house types (see scripts/houses.py for how types are chosen).
//
// Two levels of detail share the per-house data:
//   far  — one mesh per 3.8 km terrain tile: walls + gable/hip/flat roof (30 vertices a house)
//   near — per 3.8 km tile and house type, built when the camera comes close: porches on posts, stilts,
//          shop awnings, rooftop stair huts, eaves overhangs, hip roofs
//   roof kit — flat roofs within KIT_R: stainless / plastic water tanks, solar water heaters, air-conditioner units;
//          Vietnamese flags on the fronts of some shophouses (generated and kit ones)
//   building kit — within the near range, houses that fit a model of Codex's Mekong kit (kit.js) are drawn with it
//          instead of the generated near model (iC.w = 4: hidden in the near model, still drawn far away)
// The vertex shader hides each house in exactly one of the two (by its distance to the camera), so there is
// no double drawing and no gap. Windows, doors, shutters, planks, corrugated tin and roof tiles are drawn in
// the fragment shader and fade to their average colour when they get smaller than a pixel.
//
// Geometry is parametric: each vertex = unit position (scaled by width W, eaves height H, depth D)
//   + offset in metres + flags (roof rise R, stilt lift L, hip inset) — so one model fits every footprint.
import * as THREE from 'three';
import { compileTreeExclusions, treeExcluded } from './tree-exclusions.js';
import { warm } from './render/warmup.js';
import { GroupLayer, groupCentre } from './world.js';
import { photoTexture } from './photo-textures.js';
import { signAtlas } from './signs.js';
import { GLOBALS } from './render/globals.js';
import { cloudUniforms, patchCloudShadow } from './render/atmosphere.js';

const STYLE = { tube: 0, block: 1, gable: 2, hip: 3, stilt: 4, khmer: 5, hall: 6 };
// face ids (aK.w): what the fragment shader paints
const F = { front: 0, back: 1, side: 2, roof: 3, wood: 4, porch: 5, under: 6, gable: 7, hut: 8, awning: 9,
            parapet: 10, end: 11, steel: 12, solar: 13, ac: 14, tank: 15, flag: 16 };
// roof kit parts: which ones a flat-roofed house has is picked from its seed, W and D (only those are drawn)
const KIT = { tankLying: 1, tankUp: 2, solar: 3, acA: 4, acB: 5, flag: 6 };
const fract = (x) => x - Math.floor(x);
const KIT_PARTS = {
  tankLying: [[KIT.tankLying], (s) => fract(s * 5.7) < 0.5],
  tankUp: [[KIT.tankUp], (s) => fract(s * 5.7) > 0.5 && fract(s * 5.7) < 0.88],
  solar: [[KIT.solar], (s, W, D) => fract(s * 8.3) < 0.4 && D > 9],
  ac1: [[KIT.acA], (s, W) => fract(s * 2.9) < 0.6 && !(fract(s * 2.9) < 0.3 && W > 4.5)],
  ac2: [[KIT.acA, KIT.acB], (s, W) => fract(s * 2.9) < 0.3 && W > 4.5],
  flag: [[KIT.flag], (s) => fract(s * 4.1) < 0.28],
};
const KIT_R = 200;
const KIT_SUB = 3;                   // building-kit near models: 160 m sub-blocks                   // m beyond a block's edge

// ---------------------------------------------------------------- parametric geometry builder
// vertex spec: [ux, uy, uz, ox, oy, oz, r, l, hz]
const v = (ux, uy, uz, ox = 0, oy = 0, oz = 0, r = 0, l = 0, hz = 0) => [ux, uy, uz, ox, oy, oz, r, l, hz];
const SAMPLE = { W: 6, D: 12, H: 3.5, R: 1.6, L: 1.8 };
const samplePos = (p) => [p[0] * SAMPLE.W + p[3], p[1] * SAMPLE.H + p[6] * SAMPLE.R + p[7] * SAMPLE.L + p[4],
                          p[2] * SAMPLE.D + p[5] + p[8] * Math.min(SAMPLE.W, SAMPLE.D)];

class Builder {
  constructor() { this.u = []; this.o = []; this.k = []; this.idx = []; this.n = 0; }
  _add(p, face) {
    this.u.push(p[0], p[1], p[2]); this.o.push(p[3], p[4], p[5]); this.k.push(p[6], p[7], p[8], face);
    return this.n++;
  }
  // polygon (3 or 4 corners) wound so that its normal points along `out` for a sample house
  poly(pts, face, out) {
    const [a, b, c] = pts.map(samplePos);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (nrm[0] * out[0] + nrm[1] * out[1] + nrm[2] * out[2] < 0) pts = [...pts].reverse();
    const ids = pts.map((p) => this._add(p, face));
    this.idx.push(ids[0], ids[1], ids[2]);
    if (ids.length === 4) this.idx.push(ids[0], ids[2], ids[3]);
  }
  // vertical post / box sides between two y specs; corners in metres around (ux, uz) + (ox, oz)
  post(ux, uz, ox, oz, half, y0, y1, face = F.wood) {
    const P = (sx, sz, y) => v(ux, y[0], uz, ox + sx * half, y[1], oz + sz * half, 0, y[2]);
    for (const [ax, az, bx, bz, out] of [[-1, 1, 1, 1, [0, 0, 1]], [1, -1, -1, -1, [0, 0, -1]],
                                         [1, 1, 1, -1, [1, 0, 0]], [-1, -1, -1, 1, [-1, 0, 0]]]) {
      this.poly([P(ax, az, y0), P(bx, bz, y0), P(bx, bz, y1), P(ax, az, y1)], face, out);
    }
  }
  geometry() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.u, 3));
    g.setAttribute('aOff', new THREE.Float32BufferAttribute(this.o, 3));
    g.setAttribute('aK', new THREE.Float32BufferAttribute(this.k, 4));
    g.setIndex(this.idx);
    return g;
  }
}

// walls: lifted = on stilts (bottom at the stilt top), else sunk 2 m into the ground for sloping terrain
function walls(B, lifted) {
  const l = lifted ? 1 : 0, yb = lifted ? 0 : -2;
  const P = (x, y, z) => v(x, y, z, 0, y ? 0 : yb, 0, 0, l);
  B.poly([P(-0.5, 0, 0.5), P(0.5, 0, 0.5), P(0.5, 1, 0.5), P(-0.5, 1, 0.5)], F.front, [0, 0, 1]);
  B.poly([P(-0.5, 0, -0.5), P(0.5, 0, -0.5), P(0.5, 1, -0.5), P(-0.5, 1, -0.5)], F.back, [0, 0, -1]);
  B.poly([P(0.5, 0, -0.5), P(0.5, 0, 0.5), P(0.5, 1, 0.5), P(0.5, 1, -0.5)], F.side, [1, 0, 0]);
  B.poly([P(-0.5, 0, -0.5), P(-0.5, 0, 0.5), P(-0.5, 1, 0.5), P(-0.5, 1, -0.5)], F.side, [-1, 0, 0]);
}

// gable roof, ridge along the depth; os/oe = eaves overhang at the sides / gable ends (m)
function gableRoof(B, os, oe, l = 0) {
  const E = (sx, sz) => v(sx * 0.5, 1, sz * 0.5, sx * os, -os * 0.25, sz * oe, 0, l);
  const Rg = (sz) => v(0, 1, sz * 0.5, 0, 0, sz * oe, 1, l);
  B.poly([E(-1, -1), E(-1, 1), Rg(1), Rg(-1)], F.roof, [-1, 1, 0]);
  B.poly([E(1, -1), E(1, 1), Rg(1), Rg(-1)], F.roof, [1, 1, 0]);
  for (const sz of [1, -1]) {
    B.poly([v(-0.5, 1, sz * 0.5, 0, 0, 0, 0, l), v(0.5, 1, sz * 0.5, 0, 0, 0, 0, l), v(0, 1, sz * 0.5, 0, 0, 0, 1, l)],
           F.gable, [0, 0, sz]);
  }
}

// hip roof: the ridge stops W/2 short of each end (pyramid on square houses)
function hipRoof(B, os, oe, l = 0, endFace = F.roof) {
  const E = (sx, sz) => v(sx * 0.5, 1, sz * 0.5, sx * os, -os * 0.3, sz * oe, 0, l);
  const Rh = (sz) => v(0, 1, sz * 0.5, 0, 0, 0, 1, l, -sz * 0.5);
  B.poly([E(-1, -1), E(-1, 1), Rh(1), Rh(-1)], F.roof, [-1, 1, 0]);
  B.poly([E(1, -1), E(1, 1), Rh(1), Rh(-1)], F.roof, [1, 1, 0]);
  B.poly([E(-1, 1), E(1, 1), Rh(1)], endFace, [0, 1, 1]);
  B.poly([E(-1, -1), E(1, -1), Rh(-1)], endFace, [0, 1, -1]);
}

// flat concrete roof with a low parapet
function flatRoof(B) {
  const T = (x, z, oy = 0) => v(x, 1, z, 0, oy, 0);
  B.poly([T(-0.5, -0.5), T(0.5, -0.5), T(0.5, 0.5), T(-0.5, 0.5)], F.roof, [0, 1, 0]);
  for (const [a, b, out] of [[[-0.5, 0.5], [0.5, 0.5], [0, 0, 1]], [[0.5, -0.5], [-0.5, -0.5], [0, 0, -1]],
                             [[0.5, 0.5], [0.5, -0.5], [1, 0, 0]], [[-0.5, -0.5], [-0.5, 0.5], [-1, 0, 0]]]) {
    B.poly([T(a[0], a[1]), T(b[0], b[1]), T(b[0], b[1], 0.9), T(a[0], a[1], 0.9)], F.parapet, out);
  }
}

// rooftop stair hut / water-tank room at the back of a flat roof
function hut(B) {
  const P = (sx, z, y) => v(0, 1, -0.5, sx * 1.2, y, z);
  B.poly([P(-1, 3.4, 0), P(1, 3.4, 0), P(1, 3.4, 2.5), P(-1, 3.4, 2.5)], F.hut, [0, 0, 1]);
  B.poly([P(-1, 0.4, 0), P(1, 0.4, 0), P(1, 0.4, 2.5), P(-1, 0.4, 2.5)], F.hut, [0, 0, -1]);
  B.poly([P(1, 0.4, 0), P(1, 3.4, 0), P(1, 3.4, 2.5), P(1, 0.4, 2.5)], F.hut, [1, 0, 0]);
  B.poly([P(-1, 0.4, 0), P(-1, 3.4, 0), P(-1, 3.4, 2.5), P(-1, 0.4, 2.5)], F.hut, [-1, 0, 0]);
  B.poly([P(-1, 0.4, 2.5), P(1, 0.4, 2.5), P(1, 3.4, 2.5), P(-1, 3.4, 2.5)], F.roof, [0, 1, 0]);
}

// roof kit: n-sided prism between two points (metres around an anchor on the roof: ux, uz unit, y above the eaves)
function prism(B, ux, uz, a, b, r, n, face, kit, caps = true) {
  if (!B.only.includes(kit)) return;
  const ax = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(...ax), d = ax.map((c) => c / len);
  const e1 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const cr = (u, w) => [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const p1 = cr(d, e1), l1 = Math.hypot(...p1), q1 = p1.map((c) => c / l1), q2 = cr(d, q1);
  const ring = (c) => Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2, ct = Math.cos(t) * r, st = Math.sin(t) * r;
    return [c[0] + q1[0] * ct + q2[0] * st, c[1] + q1[1] * ct + q2[1] * st, c[2] + q1[2] * ct + q2[2] * st];
  });
  const A = ring(a), Bq = ring(b), P = (q) => v(ux, 1, uz, q[0], q[1], q[2], 0, 0, kit);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, mid = [(A[i][0] + A[j][0]) / 2 - a[0], (A[i][1] + A[j][1]) / 2 - a[1], (A[i][2] + A[j][2]) / 2 - a[2]];
    B.poly([P(A[i]), P(A[j]), P(Bq[j]), P(Bq[i])], face, mid);
  }
  if (caps) for (const [R, out] of [[A, d.map((c) => -c)], [Bq, d]]) for (let i = 1; i < n - 1; i += 2)
    B.poly(i + 2 < n ? [P(R[0]), P(R[i]), P(R[i + 1]), P(R[i + 2])] : [P(R[0]), P(R[i]), P(R[i + 1])], face, out);
}
// box from corner a to corner b (metres around the anchor); no bottom
function kitBox(B, ux, uz, a, b, face, kit) {
  if (!B.only.includes(kit)) return;
  const P = (x, y, z) => v(ux, 1, uz, x, y, z, 0, 0, kit);
  const [x0, y0, z0] = a, [x1, y1, z1] = b;
  B.poly([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], face, [0, 1, 0]);
  B.poly([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], face, [0, 0, 1]);
  B.poly([P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0)], face, [0, 0, -1]);
  B.poly([P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0)], face, [1, 0, 0]);
  B.poly([P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], face, [-1, 0, 0]);
}
function roofKit(B) {
  // on the stair hut (x +-1.2, z 0.4..3.4 m from the back, roof 2.5 m up): a lying stainless tank or an upright one
  prism(B, 0, -0.5, [-0.85, 3.05, 1.9], [0.85, 3.05, 1.9], 0.52, 6, F.steel, KIT.tankLying);
  kitBox(B, 0, -0.5, [-0.7, 2.5, 1.55], [0.7, 2.55, 2.25], F.steel, KIT.tankLying);
  prism(B, 0, -0.5, [-0.35, 2.5, 1.9], [-0.35, 3.75, 1.9], 0.55, 6, F.tank, KIT.tankUp);
  // solar water heater in front of the hut: tilted tube panel, its tank along the top
  const z0 = 3.9, z1 = 5.2, xa = -0.95, xb = 0.85;
  if (B.only.includes(KIT.solar)) B.poly([v(0, 1, -0.5, xa, 0.95, z0, 0, 0, KIT.solar), v(0, 1, -0.5, xb, 0.95, z0, 0, 0, KIT.solar),
          v(0, 1, -0.5, xb, 0.25, z1, 0, 0, KIT.solar), v(0, 1, -0.5, xa, 0.25, z1, 0, 0, KIT.solar)], F.solar, [0, 1, 1]);
  if (B.only.includes(KIT.solar)) B.poly([v(0, 1, -0.5, xa, 0.95, z0, 0, 0, KIT.solar), v(0, 1, -0.5, xb, 0.95, z0, 0, 0, KIT.solar),
          v(0, 1, -0.5, xb, 0.0, z0, 0, 0, KIT.solar), v(0, 1, -0.5, xa, 0.0, z0, 0, 0, KIT.solar)], F.steel, [0, 0, -1]);
  prism(B, 0, -0.5, [xa, 1.12, z0 - 0.1], [xb, 1.12, z0 - 0.1], 0.22, 6, F.steel, KIT.solar, false);
  // air-conditioner outdoor units near the front parapet
  for (const [sx, kit] of [[-1, KIT.acA], [1, KIT.acB]]) kitBox(B, sx * 0.25, 0.5, [-0.42, 0.0, -0.75], [0.42, 0.6, -0.45], F.ac, kit);
  // national flag on a pole sloping out of the front wall above the ground floor (heights from the ground: uy = 0)
  if (B.only.includes(KIT.flag)) {
    const F0 = (x, y, z) => v(0.3, 0, 0.5, x, y, z, 0, 0, KIT.flag);
    for (const [dx, dy] of [[0.03, 0], [0, 0.03]]) {
      B.poly([F0(-dx, 4.2 - dy, 0), F0(dx, 4.2 + dy, 0), F0(dx, 4.9 + dy, 1.4), F0(-dx, 4.9 - dy, 1.4)], F.steel, [dy ? 0 : 1, dy ? 1 : 0, 0]);
    }
    B.poly([F0(0, 4.32, 0.25), F0(0, 4.85, 1.3), F0(0, 4.15, 1.3), F0(0, 3.62, 0.25)], F.flag, [1, 0, 0]);
  }
}

// shophouse awning over the pavement (tarp / tin sheet), at ~2.6 m (the shop signboard above it)
function awning(B) {
  const A = (sx, oz, y) => v(sx * 0.5, 0, 0.5, -sx * 0.15, y, oz);
  B.poly([A(-1, 0, 2.72), A(1, 0, 2.72), A(1, 1.3, 2.52), A(-1, 1.3, 2.52)], F.awning, [0, 1, 0.3]);   // (signboard above)
  B.poly([A(-1, 0, 2.6), A(1, 0, 2.6), A(1, 1.3, 2.4), A(-1, 1.3, 2.4)], F.under, [0, -1, 0]);
  B.poly([A(-1, 1.3, 2.4), A(1, 1.3, 2.4), A(1, 1.3, 2.52), A(-1, 1.3, 2.52)], F.awning, [0, 0, 1]);
}

// front porch (hiên): lean-to roof on two posts, at ground-floor height
function porch(B, depth = 2.0) {
  const P = (sx, oz, y) => v(sx * 0.5, 0, 0.5, sx * 0.15, y, oz);
  B.poly([P(-1, 0, 3.05), P(1, 0, 3.05), P(1, depth, 2.55), P(-1, depth, 2.55)], F.porch, [0, 1, 0.2]);
  B.poly([P(-1, 0, 2.95), P(1, 0, 2.95), P(1, depth, 2.45), P(-1, depth, 2.45)], F.under, [0, -1, 0]);
  for (const sx of [-1, 1]) B.post(sx * 0.5, 0.5, -sx * 0.3, depth - 0.2, 0.1, [0, -0.5, 0], [0, 2.5, 0]);
}

// stilts (nhà sàn): posts from the ground to the floor, floor underside, front deck
function stilts(B) {
  const below = [0, -1.5, 0], floor = [0, 0, 1];
  for (const sx of [-1, 1]) {
    for (const uz of [-0.5, 0, 0.5]) B.post(sx * 0.5, uz, -sx * 0.18, -Math.sign(uz) * 0.18, 0.12, below, floor);
    B.post(sx * 0.5, 0.5, -sx * 0.35, 1.45, 0.1, below, floor);
  }
  const U = (x, z, oz = 0, oy = 0) => v(x, 0, z, 0, oy, oz, 0, 1);
  B.poly([U(-0.5, -0.5), U(0.5, -0.5), U(0.5, 0.5), U(-0.5, 0.5)], F.under, [0, -1, 0]);
  const Dk = (sx, oz, oy) => v(sx * 0.5, 0, 0.5, -sx * 0.25, oy, oz, 0, 1);
  B.poly([Dk(-1, 0, 0), Dk(1, 0, 0), Dk(1, 1.6, 0), Dk(-1, 1.6, 0)], F.wood, [0, 1, 0]);
  B.poly([Dk(-1, 1.6, -0.25), Dk(1, 1.6, -0.25), Dk(1, 1.6, 0), Dk(-1, 1.6, 0)], F.wood, [0, 0, 1]);
  B.poly([Dk(-1, 0, -0.25), Dk(1, 0, -0.25), Dk(1, 1.6, -0.25), Dk(-1, 1.6, -0.25)], F.under, [0, -1, 0]);
}

function houseModels() {
  const make = (fn) => { const B = new Builder(); fn(B); return B.geometry(); };
  const near = [];
  near[STYLE.tube] = make((B) => { walls(B); flatRoof(B); hut(B); awning(B); });
  near[STYLE.block] = make((B) => { walls(B); flatRoof(B); hut(B); });
  near[STYLE.gable] = make((B) => { walls(B); gableRoof(B, 0.55, 0.4); porch(B); });
  near[STYLE.hip] = make((B) => { walls(B); hipRoof(B, 0.6, 0.6); porch(B, 1.8); });
  near[STYLE.stilt] = make((B) => { walls(B, true); gableRoof(B, 0.6, 0.45, 1); stilts(B); });
  near[STYLE.khmer] = near[STYLE.stilt];
  near[STYLE.hall] = make((B) => { walls(B); gableRoof(B, 0.4, 0.3); });
  // far: plain walls + one roof that the shader turns into gable / hip / flat
  const far = make((B) => { walls(B); hipRoof(B, 0, 0, 0, F.end); });
  const kit = Object.fromEntries(Object.entries(KIT_PARTS).map(([k, [only, test]]) => {
    const B = new Builder(); B.only = only; roofKit(B); return [k, { geo: B.geometry(), test }];
  }));
  return { near, far, kit };
}

// ---------------------------------------------------------------- material
const CELLS = 8;                     // detailed houses: blocks of tileM / 8 (480 m) per tile side

const VERT_HEAD = /* glsl */`
attribute vec3 aOff;
attribute vec4 aK;
attribute vec4 iA;      // x, ground y, z (scene), front angle
attribute vec3 iB;      // W (front), D (depth), H (eaves height) in m
attribute vec4 iC;      // style, roof kind, seed 0..255, hidden (1: a detailed model stands here, 2: a landmark)
attribute vec3 iRoof;
attribute vec3 iWall;
uniform float uNearR;
uniform vec3 uViewPos;     // the viewer's camera (also in the sun's shadow pass)
uniform float uBex;
varying float vFace;
varying vec4 vInfo;     // style, roof kind, seed 0..1, is-hip
varying vec3 vRoofCol;
varying vec3 vWallCol;
varying vec4 vWall;     // along the wall, height above floor, wall length, floor height (m)
varying vec2 vRoofUV;
varying float vPhotoFade;
`;

const VERT_BODY = /* glsl */`
  float st = iC.x, kind = iC.y, seed = iC.z / 255.0;
  float W = iB.x, D = iB.y, H = iB.z;
  float pitch = st < 1.5 ? 0.0 : st < 2.5 ? (kind > 0.5 ? 0.34 : 0.27) : st < 3.5 ? 0.42
              : st < 4.5 ? 0.30 : st < 5.5 ? 0.55 : 0.13;
  float R = pitch * W;
  float L = (st > 3.5 && st < 4.5) ? 1.3 + seed * 0.9 : (st > 4.5 && st < 5.5) ? 2.0 + seed * 0.9 : 0.0;
  float isHip = (st > 2.5 && st < 3.5) ? 1.0 : 0.0;
#ifdef FAR
  L = 0.0;
#endif
  vec3 lp = vec3(position.x * W + aOff.x,
                 position.y * H + aK.x * R + aK.y * L + aOff.y,
                 position.z * D + aOff.z + aK.z * isHip * min(W, D));
  float dist = distance(uViewPos, iA.xyz);
#ifdef FAR
  bool hide = dist <= uNearR;
#else
  bool hide = dist > uNearR;
#endif
#ifdef FAR
  if (iC.w > 0.5 && iC.w < 3.5) hide = true;           // 4: drawn by the building kit near by, by this far away
#else
  if (iC.w > 0.5 && !(iC.w > 3.5 && aK.w > 11.5)) hide = true;          // (kit houses keep their flags)
#endif
  float ex = mix(1.0, uBex, smoothstep(1500.0, 6000.0, dist));   // true proportions close up
  float c = cos(iA.w), s = sin(iA.w);
  vec3 transformed = iA.xyz + vec3(-s * lp.x + c * lp.z, lp.y * ex, -c * lp.x - s * lp.z);
  if (hide) transformed = vec3(0.0);
  vPhotoFade = 1.0 - smoothstep(180.0, 650.0, dist);
  vFace = aK.w;
  vInfo = vec4(st, kind, seed, isHip);
  vRoofCol = iRoof;
  vWallCol = iWall;
  bool side = abs(aK.w - 2.0) < 0.5;
  float floorH = st < 1.5 ? 3.4 : (H > 4.8 ? H * 0.5 : H + 1.0);
  vWall = vec4(side ? lp.z : lp.x, lp.y - aK.y * L, side ? D : W, floorH);
  vRoofUV = lp.xz;
  if (abs(aK.w - 16.0) < 0.5) vRoofUV = vec2(lp.z - 0.5 * D, lp.y);      // flag: out from the wall, height
`;

const FRAG_HEAD = /* glsl */`
varying float vPhotoFade;
#ifdef NEAR
uniform sampler2D uPhotoTin, uPhotoTiles, uPhotoPlaster, uPhotoWood, uSigns;
vec3 photoDetail(sampler2D image, vec2 uv, vec3 average) {
  return mix(vec3(1.), clamp(texture2D(image, uv).rgb / average, vec3(.35), vec3(2.)), vPhotoFade);
}
// gentler version for large plain surfaces (painted walls): the stains of the photo would read as camouflage
vec3 photoDetailSoft(sampler2D image, vec2 uv, vec3 average) {
  vec3 r = clamp(texture2D(image, uv).rgb / average, vec3(.6), vec3(1.5));
  return mix(vec3(1.), mix(vec3(dot(r, vec3(.333))), r, .3), vPhotoFade * .28);
}
#endif

varying float vFace;
varying vec4 vInfo;
varying vec3 vRoofCol;
varying vec3 vWallCol;
varying vec4 vWall;
varying vec2 vRoofUV;

float hHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hHash(i), hHash(i + vec2(1, 0)), f.x), mix(hHash(i + vec2(0, 1)), hHash(i + vec2(1, 1)), f.x), f.y);
}
// window glass: dark room behind, the sky reflected more towards the top, aluminium (or old wooden) frames
vec3 glassLook(float x, float y, float halfH, float paneW, vec3 tint, float seed, float px, float py) {
  vec3 g = mix(tint * 0.55, vec3(0.30, 0.37, 0.44), 0.3 + 0.45 * smoothstep(-halfH, halfH, y));
  float fx = abs(fract(x / paneW) - 0.5) * paneW, fy = abs(y);
  float frame = max(1.0 - smoothstep(paneW * 0.5 - 0.05 - px, paneW * 0.5 - 0.05, fx),
                    (1.0 - smoothstep(0.025, 0.025 + py, fy)) * step(0.6, halfH));
  frame = max(frame, smoothstep(halfH - 0.06 - py, halfH - 0.06, fy));
  vec3 fc = fract(seed * 4.7) < 0.7 ? vec3(0.62, 0.63, 0.63) : vec3(0.22, 0.15, 0.1);
  return mix(g, fc, frame);
}
// anti-aliased rectangle centred at 0 with half sizes hx, hy
float hBox(float x, float y, float hx, float hy, float px, float py) {
  return (1.0 - smoothstep(hx - px, hx + px, abs(x))) * (1.0 - smoothstep(hy - py, hy + py, abs(y)));
}
vec3 sRGB(vec3 c) { return pow(c, vec3(2.2)); }
// signed distance to a five-pointed star of outer radius r, point up (after Inigo Quilez)
float starSd(vec2 p, float r) {
  const vec2 k1 = vec2(0.809016994, -0.587785252), k2 = vec2(-0.809016994, -0.587785252);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = 0.382 * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
`;

const FRAG_COLOR = /* glsl */`
  float st = vInfo.x, kind = vInfo.y, seed = vInfo.z;
  int face = int(vFace + 0.5);
  if (face == 11) face = vInfo.w > 0.5 ? 3 : 7;          // far model: hip end or gable wall
  vec3 roofC = sRGB(vRoofCol), wallC = sRGB(vWallCol);
  // weathering: tropical sun bleaches paint and tin, rain streaks and grime darken it (less candy-coloured towns)
  wallC = mix(vec3(dot(wallC, vec3(0.2126, 0.7152, 0.0722))), wallC, 0.55) * 0.88;
  roofC = mix(vec3(dot(roofC, vec3(0.2126, 0.7152, 0.0722))), roofC, 0.62) * 0.85;
  float hRough = 0.85;
  vec3 col;
  bool isTube = st < 0.5, isBlock = st > 0.5 && st < 1.5;
  if (face == 3 || face == 5) {
    vec2 r = vRoofUV;
    float pr = max(fwidth(r.x), fwidth(r.y));
    float vis = 1.0 - smoothstep(0.06, 0.25, pr);
    col = roofC;
    float k = kind;
    if (face == 5 && k > 1.5) k = 0.0;                     // porch roofs are tin
#ifdef NEAR
    vec2 photoUV = r / 2.0 + seed * vec2(17.13, 31.7);
    if (k < .5) { col *= photoDetail(uPhotoTin, photoUV, vec3(.411,.459,.436)); hRough=.75; }
    else if (k < 1.5 || k > 3.5) col *= photoDetail(uPhotoTiles, photoUV, vec3(.114,.034,.010));
    else if (k < 2.5) col *= photoDetail(uPhotoPlaster, photoUV, vec3(.186,.158,.112));
    else col *= photoDetail(uPhotoWood, photoUV, vec3(.166,.148,.036));
#else
    if (k < 0.5) {                                          // corrugated tin + rust
      float corr = 0.5 + 0.5 * sin(r.y * 6.2832 / 0.26);
      col *= mix(0.94, 0.82 + 0.3 * corr, vis);
      float rn = 0.6 * hNoise(r * 0.12 + seed * 40.0) + 0.4 * hNoise(r * 0.5 + seed * 17.0);
      float rust = smoothstep(0.4, 0.9, rn) * step(0.4, fract(seed * 3.7));       // older roofs only
      col = mix(col, sRGB(vec3(0.45, 0.29, 0.20)), rust * 0.45);
      hRough = 0.5;
    } else if (k < 1.5 || k > 3.5) {                        // clay / glazed tiles: rows across the slope
      float row = fract(r.x / 0.32);
      float tile = mix(0.92, mix(0.78, 1.06, smoothstep(0.0, 0.75, row)), vis);
      col *= tile * (0.92 + 0.12 * hNoise(r * 0.5 + seed * 13.0));
      hRough = k > 3.5 ? 0.35 : 0.8;
    } else if (k < 2.5) {                                   // concrete: stains, a few water tanks
      col *= 0.9 + 0.1 * hNoise(r * 0.2 + seed * 7.0) + 0.04 * hNoise(r * 1.3);
    } else {                                                // thatch / palm leaf
      col *= 0.78 + 0.3 * mix(0.5, hNoise(vec2(r.x * 4.0, r.y * 0.4) + seed * 9.0), vis);
    }
#endif
  } else if (face == 16) {                                 // Vietnamese flag: red with a yellow five-pointed star
    vec2 q = vec2(vRoofUV.x - 0.775, vRoofUV.y - (3.97 + 0.505 * (vRoofUV.x - 0.25)));   // from the (sheared) centre
    col = mix(sRGB(vec3(0.85, 0.06, 0.05)), sRGB(vec3(1.0, 0.85, 0.0)), 1.0 - smoothstep(-0.006, 0.006, starSd(q, 0.2)));
    hRough = 0.7;
  } else if (face >= 12) {                                 // roof kit
    float a = fract(seed * 3.1);
    if (face == 12 || (face == 15 && a < 0.65)) {           // stainless steel (inox) with streaks
      col = sRGB(vec3(0.7, 0.71, 0.72)) * (0.8 + 0.25 * hNoise(vRoofUV * vec2(1.0, 6.0) + seed * 5.0));
      hRough = 0.3;
    } else if (face == 15) {
      col = a < 0.85 ? sRGB(vec3(0.12, 0.32, 0.62)) : sRGB(vec3(0.85, 0.85, 0.82));     // blue / white plastic tank
      hRough = 0.5;
    } else if (face == 13) {                                // vacuum tubes
      col = sRGB(vec3(0.06, 0.08, 0.11)) * (0.75 + 0.5 * smoothstep(0.3, 0.5, abs(fract(vRoofUV.x / 0.075) - 0.5)));
      hRough = 0.2;
    } else {                                                // AC unit: off-white case
      col = sRGB(vec3(0.8, 0.8, 0.77)) * (0.9 + 0.1 * hNoise(vRoofUV * 3.0 + seed * 9.0));
    }
  } else if (face == 4) {
    col = sRGB(vec3(0.36, 0.27, 0.19));
#ifdef NEAR
    col *= photoDetail(uPhotoWood, vRoofUV / 2.0 + seed * 13., vec3(.166,.148,.036));
#endif
  } else if (face == 6) {
    col = sRGB(vec3(0.22, 0.2, 0.18));
  } else if (face == 9) {
    float a = fract(seed * 7.13);
    col = sRGB(a < 0.3 ? vec3(0.16, 0.34, 0.62) : a < 0.55 ? vec3(0.66, 0.16, 0.12)
             : a < 0.75 ? vec3(0.2, 0.46, 0.26) : vec3(0.82, 0.82, 0.8));
    hRough = 0.6;
  } else {                                                  // walls
    float al = vWall.x, hh = vWall.y, fw = vWall.z, flH = vWall.w;
    float pa = fwidth(al), ph = fwidth(hh);
    float vis = 1.0 - smoothstep(0.2, 0.6, max(pa, ph));
    col = wallC;
    bool wood = dot(vWallCol, vec3(0.33)) < 0.5 && (st > 3.5 && st < 5.5);
    if (wood && vPhotoFade < .01) col *= mix(0.92, 0.8 + 0.25 * smoothstep(0.0, 0.25, fract(hh / 0.22)), vis);
#ifdef NEAR
    vec2 wallUV = vec2(al, hh) / 2.0 + seed * vec2(17.13,31.7);
    col *= wood ? photoDetail(uPhotoWood, wallUV, vec3(.166,.148,.036))
                : photoDetailSoft(uPhotoPlaster, wallUV * 0.5, vec3(.186,.158,.112));
#endif
    bool party = isTube && (face == 2 || face == 1);         // tube houses: bare concrete side walls
    if (party) col = mix(col, sRGB(vec3(0.6, 0.58, 0.55)), 0.7) * (0.85 + 0.2 * hNoise(vec2(al, hh) * 0.4));
    vec3 glass = seed < 0.45 || isTube || isBlock ? sRGB(vec3(0.16, 0.2, 0.23))
               : seed < 0.7 ? sRGB(vec3(0.2, 0.42, 0.55)) : sRGB(vec3(0.24, 0.5, 0.36));
    float fl = floor(hh / flH), fy = hh - fl * flH;
    float m = 0.0;
    vec3 mc = glass;
    if ((face <= 2 || face == 8) && !party && hh > 0.0) {
      bool shop = face == 0 && fl < 0.5 && (isTube || (isBlock && fract(seed * 3.3) < 0.5));
      if (shop) {
        // ground-floor shop: open front with goods on shelves, a roll-up shutter or a glass front, signboard above
        float sk = fract(seed * 5.31);
        m = hBox(al, hh - 1.3, fw * 0.5 - 0.2, 1.3, pa, ph);
        if (sk < 0.55) {
          vec2 cell = floor(vec2(al / 0.35, hh / 0.42));
          float g = hHash(cell + seed * 91.0), shelf = step(0.25, fract(hh / 0.42));
          vec3 goods = sRGB(vec3(0.35 + 0.55 * g, 0.25 + 0.6 * fract(g * 7.1), 0.15 + 0.7 * fract(g * 13.7)));
          mc = mix(sRGB(vec3(0.07, 0.065, 0.06)), goods, shelf * step(0.35, g) * (1.0 - smoothstep(0.0, 0.6, hh - 2.0)) * 0.55);
          mc = mix(mc, sRGB(vec3(0.42, 0.4, 0.37)), 1.0 - smoothstep(0.0, 0.08, hh));             // floor tiles
        } else if (sk < 0.85) {
          mc = sRGB(vec3(0.44, 0.46, 0.47)) * (0.82 + 0.18 * step(0.5, fract(hh / 0.1)));      // roll-up shutter
        } else {
          mc = mix(sRGB(vec3(0.12, 0.16, 0.19)), sRGB(vec3(0.5, 0.58, 0.62)), 0.25 * smoothstep(0.0, 2.6, hh));   // glass
        }
        if (fract(seed * 9.7) < 0.75) {
          float sy = hh - 3.07, sb = hBox(al, sy, fw * 0.5 - 0.05, 0.3, pa, ph);   // (above the awning)
          float pc = fract(seed * 2.17);
          vec3 board = pc < 0.3 ? vec3(0.78, 0.1, 0.08) : pc < 0.5 ? vec3(0.95, 0.78, 0.15)
                     : pc < 0.7 ? vec3(0.1, 0.3, 0.68) : pc < 0.85 ? vec3(0.93, 0.93, 0.9) : vec3(0.1, 0.48, 0.25);
          vec3 ink = pc < 0.3 || pc > 0.85 ? vec3(0.98, 0.95, 0.6) : pc < 0.5 ? vec3(0.75, 0.08, 0.06)
                   : pc < 0.7 ? vec3(0.97) : vec3(0.8, 0.1, 0.08);
#ifdef NEAR
          // the shop's name from the lettering atlas (signs.js), centred on the board at its own proportions
          vec2 su = vec2(al / 2.4 + 0.5, 0.5 - sy / 0.6);
          float ci = floor(fract(seed * 13.7) * 32.0);
          float letter = su.x > 0.02 && su.x < 0.98 && abs(al) < fw * 0.5 - 0.15
                       ? texture2D(uSigns, (vec2(mod(ci, 4.0), floor(ci / 4.0)) + clamp(su, 0.0, 1.0)) / vec2(4.0, 8.0)).r : 0.0;
#else
          float letter = step(0.3, hHash(vec2(floor(al / 0.2), seed * 37.0))) * hBox(mod(al, 0.2) - 0.1, sy + 0.02, 0.07, 0.12, pa, ph)
                       * step(abs(al), fw * 0.5 - 0.5);
#endif
          vec3 bc = mix(sRGB(board), sRGB(ink), letter);
          mc = mix(mc, bc, sb);
          m = max(m, sb);
        }
      } else if (face == 0 && isTube) {
        if (fl < 0.5) { m = hBox(al, hh - 1.45, fw * 0.5 - 0.35, 1.45, pa, ph);               // roll-up shutter
                        mc = sRGB(vec3(0.42, 0.44, 0.45)) * (0.85 + 0.15 * step(0.5, fract(hh / 0.12))); }
        else { m = hBox(al, fy - 1.6, fw * 0.5 - 0.5, 0.95, pa, ph);                           // glass doors to the balcony
               mc = glassLook(al, fy - 1.6, 0.95, max((fw - 1.0) / max(floor((fw - 1.0) / 0.9), 1.0), 0.5), glass, seed, pa, ph);
               float rail = hBox(al, fy - 0.95, fw * 0.5 - 0.3, 0.05, pa, ph)
                          + hBox(al, fy - 0.55, fw * 0.5 - 0.3, 0.4, pa, ph) * step(0.5, fract(al / 0.12)) * 0.8;
               mc = mix(mc, sRGB(vec3(0.82, 0.82, 0.8)), min(rail, 1.0)); m = max(m, min(rail, 1.0)); }
      } else if (face != 8) {
        float n = max(1.0, floor(fw / (isBlock ? 2.6 : 3.2)));
        float cell = fw / n;
        float ax = mod(al + fw * 0.5, cell) - cell * 0.5;
        m = hBox(ax, fy - 1.65, isBlock ? 0.8 : 0.55, 0.6, pa, ph);
        mc = glassLook(ax, fy - 1.65, 0.6, isBlock ? 0.8 : 0.55, glass, seed, pa, ph);
        if (face == 0 && fl < 0.5) {                                                          // front door
          float door = hBox(al, hh - 1.15, isBlock ? 1.4 : 0.85, 1.15, pa, ph);
          mc = mix(mc, seed < 0.5 ? sRGB(vec3(0.3, 0.2, 0.13)) : sRGB(vec3(0.18, 0.3, 0.42)), door);
          m = max(m, door);
        }
      } else {
        m = hBox(al, hh - 1.0, 0.45, 1.0, pa, ph);
        mc = sRGB(vec3(0.3, 0.3, 0.32));
      }
    }
    vec3 detail = mix(col, mc, m);
    col = mix(mix(col, glass, face == 7 || face == 10 ? 0.0 : 0.12), detail, vis);
    if (hh < 0.35 && !(st > 3.5 && st < 5.5)) col *= 0.62;                                  // plinth
    if (face == 10) col *= 1.05;
  }
  diffuseColor.rgb = col;
`;

function houseMaterial(lod, uniforms) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, flatShading: true });
  mat.defines = { [lod]: '' };
  const photos = lod === 'NEAR' ? Object.fromEntries([
    ['uPhotoTin','corrugated_iron'], ['uPhotoTiles','clay_roof_tiles'],
    ['uPhotoPlaster','worn_plaster_wall'], ['uPhotoWood','wooden_rough_planks'],
  ].map(([key,id]) => [key,{value:photoTexture(`models/${id}-color.webp`,{repeat:true})}])) : {};
  if (lod === 'NEAR') photos.uSigns = { value: signAtlas() };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, photos);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <begin_vertex>', VERT_BODY);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = hRough;');
    patchCloudShadow(sh, cloudUniforms());
  };
  mat.customProgramCacheKey = () => 'cuulong-houses-' + lod;
  // shadow pass: the same houses in the same places
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.defines = { [lod]: '' };
  depth.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <begin_vertex>', VERT_BODY);
  };
  depth.customProgramCacheKey = () => 'cuulong-houses-depth-' + lod;
  mat.userData.depthMaterial = depth;
  return mat;
}

// ---------------------------------------------------------------- layer
export class HouseLayer extends GroupLayer {
  /** maxDistance: far models are hidden beyond it; nearR: detailed models within it (m from the camera). */
  constructor(meta, maxDistance, nearR = 1800, terrain = null) {
    super('buildings', meta);
    this.maxDistance = maxDistance;
    this.terrain = terrain;
    this.rejectedWater = 0;
    this.jobs = new Map();                     // tile -> steps: detailed tiles being built (update)
    this.nearR = nearR;
    this.nStyles = meta.house_styles.length;
    this.nTiles = meta.house_tiles;
    this.span = meta.group * meta.grid_res_m;
    this.tileM = this.span / this.nTiles;
    this.models = houseModels();
    this.buildingKit = null;     // kit.js, once loaded
    this.uniforms = { uNearR: { value: nearR }, uBex: { value: meta.building_exag }, uViewPos: GLOBALS.uViewPos };
    this.matFar = houseMaterial('FAR', this.uniforms);
    this.matNear = houseMaterial('NEAR', this.uniforms);
    this.tiles = [];            // { cx, cz, yMin, yMax, ranges: [[style, start, count]], data, meshes, used }
    this.built = 0;
    this.frame = 0;
  }

  async loadCell(gx, gy, url) {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    const n = new DataView(buf).getInt32(0, true);
    const NT = this.nTiles, NS = this.nStyles;
    const table = new Uint32Array(buf, 4, NT * NT * NS);
    let o = 4 + NT * NT * NS * 4;
    const take = (T, b, k = 1) => { const a = new T(buf, o, n * k); o += n * b * k; return a; };
    const x = take(Int16Array, 2), y = take(Int16Array, 2), g = take(Uint16Array, 2);
    const w = take(Uint8Array, 1), d = take(Uint8Array, 1), ang = take(Uint8Array, 1), ht = take(Uint8Array, 1);
    const style = take(Uint8Array, 1), kind = take(Uint8Array, 1);
    const roof = take(Uint8Array, 1, 3), wall = take(Uint8Array, 1, 3);
    const [cx, cy] = groupCentre(this.meta, gx, gy), ex = this.meta.vert_exag;

    const iA = new Float32Array(n * 4), iB = new Float32Array(n * 3), iC = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const xx = cx + x[i] / 2, yy = cy + y[i] / 2;
      const theta = (ang[i] / 256) * Math.PI * 2;
      const flooded = this.terrain?.wetland && this.terrain.wetland.floodAt(xx, yy) > .65;
      const allowed = !flooded && (!this.terrain?.surface || this.terrain.surface.allowsHouse(xx, yy, w[i] / 4, d[i] / 2, theta, style[i]));
      const gy_ = (this.terrain ? this.terrain.heightAt(xx, yy) * ex : (g[i] / 10) * ex) - 0.3;
      if (!allowed) this.rejectedWater++;
      iA.set([cx + x[i] / 2, gy_, -(cy + y[i] / 2), (ang[i] / 256) * Math.PI * 2], i * 4);
      iB.set([w[i] / 4, d[i] / 2, ht[i] / 4], i * 3);
      iC.set([style[i], kind[i], (Math.imul(i + 1, 2654435761) ^ Math.imul(gx * 7 + gy, 40503)) >>> 24, allowed ? 0 : 3], i * 4);
    }
    const data = { iA, iB, iC, roof, wall };

    // per terrain tile (instances are sorted by tile, then style): one far mesh + near-model ranges
    let start = 0;
    for (let t = 0; t < NT * NT; t++) {
      const ranges = [], first = start;
      let tMin = Infinity, tMax = -Infinity;
      for (let s = 0; s < NS; s++) {
        const c = table[t * NS + s];
        if (c) ranges.push([s, start, c]);
        for (let i = start; i < start + c; i++) { tMin = Math.min(tMin, iA[i * 4 + 1]); tMax = Math.max(tMax, iA[i * 4 + 1]); }
        start += c;
      }
      if (!ranges.length) continue;
      const tx = t % NT, ty = Math.floor(t / NT);
      const T = { cx: cx - this.span / 2 + (tx + 0.5) * this.tileM, cz: -(cy + this.span / 2 - (ty + 0.5) * this.tileM),
                  yMin: tMin, yMax: tMax, ranges, data, meshes: null, used: 0 };
      T.cells = this.sortIntoCells(T, data, first, start - first, (tMin + tMax) / 2);
      T.ranges = [[-1, first, start - first]];                 // (by style no longer: by block, then style)
      T.sphere = new THREE.Sphere(new THREE.Vector3(T.cx, (tMin + tMax) / 2, T.cz),
                                  this.tileM * 0.75 + (tMax - tMin) / 2 + 60);
      const { geometry } = this.instanced(this.models.far, data, first, start - first);
      geometry.boundingSphere = T.sphere;
      T.far = new THREE.Mesh(geometry, this.matFar);
      T.far.raycast = () => {};
      T.far.userData.occBox = this.box(T.cx, T.cz, this.tileM / 2, T);        // occlusion culling (render/occlusion.js)
      T.far.userData.noShadow = true;            // far houses are hidden where shadows are drawn
      this.group.add(T.far);
      this.tiles.push(T);
    }
  }

  /**
   * Houses near the camera are drawn per CELLS x CELLS block of a tile, so blocks out of reach are not sent to the GPU
   * at all. Reorders the tile's data by (block, style) before anything refers to house indices and returns the
   * blocks: { sphere, start, count, parts: [[style, start, count]...] }.
   */
  sortIntoCells(T, data, first, total, yMid) {
    const cw = this.tileM / CELLS, x0 = T.cx - this.tileM / 2, z0 = T.cz - this.tileM / 2;
    const cellOf = (i) => Math.min(CELLS - 1, Math.max(0, Math.floor((data.iA[i * 4] - x0) / cw)))
                        + CELLS * Math.min(CELLS - 1, Math.max(0, Math.floor((data.iA[i * 4 + 2] - z0) / cw)));
    const key = Array.from({ length: total }, (_, j) => cellOf(first + j) * 16 + data.iC[(first + j) * 4]);
    const order = key.map((_, j) => j).sort((a, b) => key[a] - key[b]);
    for (const [a, k] of [[data.iA, 4], [data.iB, 3], [data.iC, 4], [data.roof, 3], [data.wall, 3]]) {
      const copy = a.slice(first * k, (first + total) * k);
      order.forEach((j, n) => a.set(copy.subarray(j * k, j * k + k), (first + n) * k));
    }
    const cells = [];
    let n = 0;
    while (n < total) {
      const c = key[order[n]] >> 4, cell = { start: first + n, parts: [],
        sphere: new THREE.Sphere(new THREE.Vector3(x0 + (c % CELLS + 0.5) * cw, yMid, z0 + (Math.floor(c / CELLS) + 0.5) * cw), cw * 0.75 + 60) };
      while (n < total && key[order[n]] >> 4 === c) {
        const st = key[order[n]] & 15;
        let m = n;
        while (m < total && key[order[m]] === key[order[n]]) m++;
        cell.parts.push([st, first + n, m - n]);
        n = m;
      }
      cell.count = first + n - cell.start;
      cells.push(cell);
    }
    return cells;
  }

  instanced(model, data, start, count) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = model.index;
    for (const k of ['position', 'aOff', 'aK']) geo.setAttribute(k, model.attributes[k]);
    const sub = (a, k) => a.subarray(start * k, (start + count) * k);
    geo.setAttribute('iA', new THREE.InstancedBufferAttribute(sub(data.iA, 4), 4));
    geo.setAttribute('iB', new THREE.InstancedBufferAttribute(sub(data.iB, 3), 3));
    geo.setAttribute('iC', new THREE.InstancedBufferAttribute(sub(data.iC, 4), 4));
    geo.setAttribute('iRoof', new THREE.InstancedBufferAttribute(sub(data.roof, 3), 3, true));
    geo.setAttribute('iWall', new THREE.InstancedBufferAttribute(sub(data.wall, 3), 3, true));
    geo.instanceCount = count;
    return { geometry: geo };
  }

  /**
   * A box surely containing the houses centred within half-size `half` of (x, z): houses reach out of their cell by up
   * to half a long hall, and up to 130 m above the tile's highest ground (60 m blocks, x2 far away).
   */
  box(x, z, half, T) {
    const m = half + 80;
    return new THREE.Box3(new THREE.Vector3(x - m, T.yMin - 3, z - m), new THREE.Vector3(x + m, T.yMax + 130, z + m));
  }

  /** Like instanced(), for a list of houses (copies of their data; setHidden keeps them in step). */
  gathered(model, data, list, kitSel = null) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = model.index;
    for (const [k, a] of Object.entries(model.attributes)) geo.setAttribute(k, a);
    const pick = (a, k) => { const out = new a.constructor(list.length * k); list.forEach((i, j) => out.set(a.subarray(i * k, i * k + k), j * k)); return out; };
    geo.setAttribute('iA', new THREE.InstancedBufferAttribute(pick(data.iA, 4), 4));
    const iB = pick(data.iB, 3);
    if (kitSel) list.forEach((i, j) => { const sel = kitSel.get(i); iB[j * 3] = sel[1]; iB[j * 3 + 1] = sel[2]; });  // kit size
    geo.setAttribute('iB', new THREE.InstancedBufferAttribute(iB, 3));
    geo.setAttribute('iC', new THREE.InstancedBufferAttribute(pick(data.iC, 4), 4));
    geo.setAttribute('iRoof', new THREE.InstancedBufferAttribute(pick(data.roof, 3), 3, true));
    geo.setAttribute('iWall', new THREE.InstancedBufferAttribute(pick(data.wall, 3), 3, true));
    geo.instanceCount = list.length;
    geo.userData.list = list;
    return geo;
  }

  /** Pick building-kit models for the houses of tile T (once; marks them iC.w = 4). */
  assignKit(T) {
    const K = this.buildingKit, D = T.data;
    T.kitSel = new Map();
    for (const [, start, count] of T.ranges) for (let i = start; i < start + count; i++) {
      if (D.iC[i * 4 + 3] !== 0) continue;
      const sel = K.choose(D.iC[i * 4], D.iC[i * 4 + 1], D.iB[i * 3], D.iB[i * 3 + 1], D.iB[i * 3 + 2], D.iC[i * 4 + 2] / 255,
                           D.iA[i * 4], -D.iA[i * 4 + 2]);
      if (sel) { T.kitSel.set(i, sel); D.iC[i * 4 + 3] = 4; }
    }
    T.far.geometry.attributes.iC.needsUpdate = true;
  }

  /** The building kit has loaded: rebuild the detailed tiles with it. */
  setBuildingKit(kit) {
    this.buildingKit = kit;
    for (const T of this.tiles) if (T.meshes) this.disposeTile(T);
  }

  buildTile(T) { const g = this.buildTileSteps(T); while (!g.next().done); }

  // the detailed meshes of a tile, block by block (update() runs this a few ms per frame; the far copies show meanwhile)
  *buildTileSteps(T) {
    if (this.buildingKit?.ready && !T.kitSel) this.assignKit(T);
    const grp = new THREE.Group();
    const cw = this.tileM / CELLS;
    for (const c of T.cells) {
      yield;
      const cg = new THREE.Group();
      cg.userData.sphere = c.sphere;
      cg.userData.occBox = this.box(c.sphere.center.x, c.sphere.center.z, cw / 2, T);
      for (const [s, start, count] of c.parts) {
        const { geometry } = this.instanced(this.models.near[s], T.data, start, count);
        geometry.boundingSphere = c.sphere;
        const m = new THREE.Mesh(geometry, this.matNear);
        m.raycast = () => {};
        cg.add(m);
      }
      // roof kit for the flat roofs of the block (tube houses, blocks), shown closer in
      const kit = new THREE.Group(), D = T.data;
      const flat = c.parts.filter(([s]) => s === STYLE.tube || s === STYLE.block).flatMap(([, start, count]) =>
        Array.from({ length: count }, (_, j) => start + j)).filter((i) => D.iB[i * 3 + 1] >= 6 && D.iC[i * 4 + 3] !== 4);
      for (const [name, { geo, test }] of Object.entries(this.models.kit)) {
        if (name === 'flag') continue;
        const list = flat.filter((i) => test(D.iC[i * 4 + 2] / 255, D.iB[i * 3], D.iB[i * 3 + 1]));
        if (!list.length) continue;
        const geometry = this.gathered(geo, D, list);
        geometry.boundingSphere = c.sphere;
        const m = new THREE.Mesh(geometry, this.matNear);
        m.raycast = () => {};
        kit.add(m);
      }
      // flags: generated tube houses and kit shophouses (in the kit's size)
      const flagTest = this.models.kit.flag.test, isShop = (i) => this.buildingKit?.models[T.kitSel.get(i)[0] - 1].type === 'shophouse';
      const tubes = c.parts.filter(([s]) => s === STYLE.tube).flatMap(([, start, count]) => Array.from({ length: count }, (_, j) => start + j))
        .filter((i) => D.iB[i * 3 + 2] > 4.5 && flagTest(D.iC[i * 4 + 2] / 255));
      for (const [list, sel] of [[tubes.filter((i) => D.iC[i * 4 + 3] !== 4), null], [tubes.filter((i) => D.iC[i * 4 + 3] === 4 && isShop(i)), T.kitSel]]) {
        if (!list.length) continue;
        const geometry = this.gathered(this.models.kit.flag.geo, D, list, sel);
        geometry.boundingSphere = c.sphere;
        const m = new THREE.Mesh(geometry, this.matNear);
        m.raycast = () => {};
        kit.add(m);
      }
      if (kit.children.length) { cg.add(kit); cg.userData.kit = kit; }
      // building kit models: far ones with the block, near ones per KIT_SUB x KIT_SUB sub-block (they are heavier)
      if (T.kitSel) {
        const cw = this.tileM / CELLS, sw = cw / KIT_SUB, x0 = c.sphere.center.x - cw / 2, z0 = c.sphere.center.z - cw / 2;
        const subs = new Map();                            // sub-block -> model -> houses
        for (let i = c.start; i < c.start + c.count; i++) {
          const sel = T.kitSel.get(i);
          if (!sel) continue;
          const sx = Math.min(KIT_SUB - 1, Math.max(0, Math.floor((D.iA[i * 4] - x0) / sw)));
          const sz = Math.min(KIT_SUB - 1, Math.max(0, Math.floor((D.iA[i * 4 + 2] - z0) / sw)));
          const key = sz * KIT_SUB + sx;
          if (!subs.has(key)) subs.set(key, new Map());
          const byModel = subs.get(key);
          if (!byModel.has(sel[0])) byModel.set(sel[0], []);
          byModel.get(sel[0]).push(i);
        }
        const K = this.buildingKit, mesh = (geometry, mat, parent, sphere) => {
          geometry.boundingSphere = sphere;
          const m = new THREE.Mesh(geometry, mat);
          m.raycast = () => {};
          parent.add(m);
        };
        const farLists = new Map();
        cg.userData.kitNear = [];
        for (const [key, byModel] of subs) {
          const sg = new THREE.Group();
          sg.userData.sphere = new THREE.Sphere(new THREE.Vector3(x0 + (key % KIT_SUB + 0.5) * sw, c.sphere.center.y,
                                                                  z0 + (Math.floor(key / KIT_SUB) + 0.5) * sw), sw * 0.75 + 40);
          sg.userData.occBox = this.box(sg.userData.sphere.center.x, sg.userData.sphere.center.z, sw / 2, T);
          for (const [k, list] of byModel) {
            mesh(this.gathered(K.models[k - 1].near, D, list, T.kitSel), K.matNear, sg, sg.userData.sphere);
            sg.children[sg.children.length - 1].userData.noReflect = true;           // the water mirrors the light versions
            if (!farLists.has(k)) farLists.set(k, []);
            farLists.get(k).push(...list);
          }
          cg.add(sg);
          cg.userData.kitNear.push(sg);
        }
        for (const [k, list] of farLists) mesh(this.gathered(K.models[k - 1].far, D, list, T.kitSel), K.matFar, cg, c.sphere);
      }
      // the same block as simple far models, for when it is only partly within reach
      const { geometry } = this.instanced(this.models.far, T.data, c.start, c.count);
      geometry.boundingSphere = c.sphere;
      const f = new THREE.Mesh(geometry, this.matFar);
      f.raycast = () => {};
      f.userData.noShadow = true;
      f.userData.far = true;
      f.userData.occBox = cg.userData.occBox.clone();
      cg.userData.far = f;
      grp.add(cg, f);
    }
    // houses hidden or replaced while this was being built (setHidden): copy their flags into the gathered meshes
    grp.traverse((m) => {
      const list = m.isMesh && m.geometry.userData.list, a = list && m.geometry.attributes.iC;
      if (a) { for (let j = 0; j < list.length; j++) a.array[j * 4 + 3] = T.data.iC[list[j] * 4 + 3]; a.needsUpdate = true; }
    });
    this.group.add(grp);
    T.meshes = grp;
    this.built++;
  }

  disposeTile(T) {
    this.group.remove(T.meshes);
    T.meshes.traverse((m) => {                   // detach the shared model buffers so only per-house buffers are freed
      if (!m.isMesh) return;
      for (const [k, a] of Object.entries(m.geometry.attributes)) if (!a.isInstancedBufferAttribute) m.geometry.deleteAttribute(k);
      m.geometry.index = null;
      m.geometry.dispose();
    });
    T.meshes = null;
    this.built--;
  }

  /** Hide / show house i of tile T (flag: 0 shown, 1 replaced, 2 under a landmark, 3 rejected on water; 4 kit). */
  setHidden(T, i, flag) {
    if (flag === 0 && T.kitSel?.has(i)) flag = 4;
    if (T.data.iC[i * 4 + 3] === 3 || T.data.iC[i * 4 + 3] === flag) return;
    T.data.iC[i * 4 + 3] = flag;
    T.far.geometry.attributes.iC.needsUpdate = true;
    if (T.meshes) T.meshes.traverse((m) => {
      if (!m.isMesh) return;
      const list = m.geometry.userData.list, a = m.geometry.attributes.iC;
      if (list) { const j = list.indexOf(i); if (j < 0) return; a.array[j * 4 + 3] = flag; }
      a.needsUpdate = true;
    });
  }

  /** Hide every house whose centre lies in a rotated rectangle (scene x, z; half sizes along / across `ang`). */
  hideInRect(x, z, ang, halfA, halfB) {
    const ca = Math.cos(ang), sa = Math.sin(ang), r = Math.hypot(halfA, halfB) + this.tileM;
    for (const T of this.tiles) {
      if (Math.hypot(T.cx - x, T.cz - z) > r) continue;
      for (const [, start, count] of T.ranges) for (let i = start; i < start + count; i++) {
        const dx = T.data.iA[i * 4] - x, dz = T.data.iA[i * 4 + 2] - z;
        if (Math.abs(dx * ca + dz * sa) < halfA && Math.abs(-dx * sa + dz * ca) < halfB) this.setHidden(T, i, 2);
      }
    }
  }

  /** Exact authored footprint replacement; points use scene east/north metres. */
  hideInPolygon(points) {
    const zones = compileTreeExclusions([{ type: 'polygon', polygon_scene_EN: points }]);
    if (!zones.length) return 0;
    const b = zones[0].bounds, half = this.tileM / 2;
    let matched = 0;
    for (const T of this.tiles) {
      if (T.cx + half < b[0] || T.cx - half > b[2] || -T.cz + half < b[1] || -T.cz - half > b[3]) continue;
      for (const [, start, count] of T.ranges) for (let i = start; i < start + count; i++) {
        if (!treeExcluded(zones, T.data.iA[i * 4], -T.data.iA[i * 4 + 2])) continue;
        this.setHidden(T, i, 2); matched++;
      }
    }
    return matched;
  }

  update(camera) {
    this.frame++;
    const p = camera.position, half = this.tileM / 2, reach = this.nearR + 50;
    for (const T of this.tiles) {
      const dx = Math.max(Math.abs(p.x - T.cx) - half, 0), dz = Math.max(Math.abs(p.z - T.cz) - half, 0);
      const dy = p.y > T.yMax ? p.y - T.yMax : p.y < T.yMin ? T.yMin - p.y : 0;
      const dist = Math.hypot(dx, dy, dz);
      T.far.visible = dist < this.maxDistance;
      const near = dist < reach + this.tileM * 0.1;
      T.dist = dist;
      if (near) {
        if (!T.meshes || T.warming) {               // being built in steps (below) / compiled; the far copies stand in
          if (!this.jobs.has(T)) this.jobs.set(T, this.buildTileSteps(T));
          T.used = this.frame;
          continue;
        }
        T.meshes.visible = true;
        T.far.visible = false;                    // drawn per block instead
        for (const cg of T.meshes.children) {     // detailed blocks within reach; simple ones unless fully within it
          if (!cg.userData.sphere) continue;
          const c = cg.userData.sphere.center, r = cg.userData.sphere.radius;
          const d = Math.hypot(c.x - p.x, c.z - p.z, Math.max(p.y - T.yMax, 0));
          cg.visible = d < reach + r;
          if (cg.userData.kit) cg.userData.kit.visible = d < KIT_R + r;
          if (cg.userData.kitNear) for (const sg of cg.userData.kitNear) {
            const sc = sg.userData.sphere.center;
            sg.visible = Math.hypot(sc.x - p.x, sc.z - p.z, Math.max(p.y - T.yMax, 0)) < this.buildingKit.uniforms.uKitNear.value + sg.userData.sphere.radius;
          }
          cg.userData.far.visible = d > this.nearR - r && d < this.maxDistance + r;
        }
        T.used = this.frame;
      } else if (T.meshes) {
        T.meshes.visible = false;
      }
    }
    // run the tile builds ~4 ms per frame, nearest first (a town tile took up to ~40 ms in one go)
    const deadline = performance.now() + 4;
    for (const [T, steps] of [...this.jobs].sort((a, b) => a[0].dist - b[0].dist)) {
      if (T.dist > reach * 2) { this.jobs.delete(T); continue; }
      let r;
      while (performance.now() < deadline && !(r = steps.next()).done);
      if (r && r.done) {
        this.jobs.delete(T); T.meshes.visible = false; T.warming = true;
        warm(T.meshes).then(() => { T.warming = false; });     // shown once its shaders are ready
      }
      if (performance.now() >= deadline) break;
    }
    if (this.built > 24) {                       // free the least recently used tiles
      const old = this.tiles.filter((T) => T.meshes && T.used < this.frame).sort((a, b) => a.used - b.used);
      for (const T of old.slice(0, this.built - 24)) this.disposeTile(T);
    }
  }
}
