// Real building footprints drawn as An Giang house types (see scripts/houses.py for how types are chosen).
//
// Two levels of detail share the per-house data:
//   far  — one mesh per 3.8 km terrain tile: walls + gable/hip/flat roof (30 vertices a house)
//   near — per 3.8 km tile and house type, built when the camera comes close: porches on posts, stilts,
//          shop awnings, rooftop stair huts, eaves overhangs, hip roofs
// The vertex shader hides each house in exactly one of the two (by its distance to the camera), so there is
// no double drawing and no gap. Windows, doors, shutters, planks, corrugated tin and roof tiles are drawn in
// the fragment shader and fade to their average colour when they get smaller than a pixel.
//
// Geometry is parametric: each vertex = unit position (scaled by width W, eaves height H, depth D)
//   + offset in metres + flags (roof rise R, stilt lift L, hip inset) — so one model fits every footprint.
import * as THREE from 'three';
import { GroupLayer, groupCentre } from './world.js';

const STYLE = { tube: 0, block: 1, gable: 2, hip: 3, stilt: 4, khmer: 5, hall: 6 };
// face ids (aK.w): what the fragment shader paints
const F = { front: 0, back: 1, side: 2, roof: 3, wood: 4, porch: 5, under: 6, gable: 7, hut: 8, awning: 9,
            parapet: 10, end: 11 };

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

// shophouse awning over the pavement (tarp / tin sheet), at ~3 m
function awning(B) {
  const A = (sx, oz, y) => v(sx * 0.5, 0, 0.5, -sx * 0.15, y, oz);
  B.poly([A(-1, 0, 3.15), A(1, 0, 3.15), A(1, 1.3, 2.95), A(-1, 1.3, 2.95)], F.awning, [0, 1, 0.3]);
  B.poly([A(-1, 0, 3.0), A(1, 0, 3.0), A(1, 1.3, 2.8), A(-1, 1.3, 2.8)], F.under, [0, -1, 0]);
  B.poly([A(-1, 1.3, 2.8), A(1, 1.3, 2.8), A(1, 1.3, 2.95), A(-1, 1.3, 2.95)], F.awning, [0, 0, 1]);
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
  return { near, far };
}

// ---------------------------------------------------------------- material
const VERT_HEAD = /* glsl */`
attribute vec3 aOff;
attribute vec4 aK;
attribute vec4 iA;      // x, ground y, z (scene), front angle
attribute vec3 iB;      // W (front), D (depth), H (eaves height) in m
attribute vec4 iC;      // style, roof kind, seed 0..255, -
attribute vec3 iRoof;
attribute vec3 iWall;
uniform float uNearR;
uniform float uBex;
varying float vFace;
varying vec4 vInfo;     // style, roof kind, seed 0..1, is-hip
varying vec3 vRoofCol;
varying vec3 vWallCol;
varying vec4 vWall;     // along the wall, height above floor, wall length, floor height (m)
varying vec2 vRoofUV;
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
  float dist = distance(cameraPosition, iA.xyz);
#ifdef FAR
  bool hide = dist <= uNearR;
#else
  bool hide = dist > uNearR;
#endif
  float ex = mix(1.0, uBex, smoothstep(1500.0, 6000.0, dist));   // true proportions close up
  float c = cos(iA.w), s = sin(iA.w);
  vec3 transformed = iA.xyz + vec3(-s * lp.x + c * lp.z, lp.y * ex, -c * lp.x - s * lp.z);
  if (hide) transformed = vec3(0.0);
  vFace = aK.w;
  vInfo = vec4(st, kind, seed, isHip);
  vRoofCol = iRoof;
  vWallCol = iWall;
  bool side = abs(aK.w - 2.0) < 0.5;
  float floorH = st < 1.5 ? 3.4 : (H > 4.8 ? H * 0.5 : H + 1.0);
  vWall = vec4(side ? lp.z : lp.x, lp.y - aK.y * L, side ? D : W, floorH);
  vRoofUV = lp.xz;
`;

const FRAG_HEAD = /* glsl */`
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
// anti-aliased rectangle centred at 0 with half sizes hx, hy
float hBox(float x, float y, float hx, float hy, float px, float py) {
  return (1.0 - smoothstep(hx - px, hx + px, abs(x))) * (1.0 - smoothstep(hy - py, hy + py, abs(y)));
}
vec3 sRGB(vec3 c) { return pow(c, vec3(2.2)); }
`;

const FRAG_COLOR = /* glsl */`
  float st = vInfo.x, kind = vInfo.y, seed = vInfo.z;
  int face = int(vFace + 0.5);
  if (face == 11) face = vInfo.w > 0.5 ? 3 : 7;          // far model: hip end or gable wall
  vec3 roofC = sRGB(vRoofCol), wallC = sRGB(vWallCol);
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
    if (k < 0.5) {                                          // corrugated tin + rust
      float corr = 0.5 + 0.5 * sin(r.y * 6.2832 / 0.26);
      col *= mix(0.94, 0.82 + 0.3 * corr, vis);
      float rn = 0.6 * hNoise(r * 0.12 + seed * 40.0) + 0.4 * hNoise(r * 0.5 + seed * 17.0);
      float rust = smoothstep(0.45, 0.95, rn) * step(0.55, fract(seed * 3.7));     // older roofs only
      col = mix(col, sRGB(vec3(0.48, 0.30, 0.20)), rust * 0.3);
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
  } else if (face == 4) {
    col = sRGB(vec3(0.36, 0.27, 0.19));
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
    if (wood) col *= mix(0.92, 0.8 + 0.25 * smoothstep(0.0, 0.25, fract(hh / 0.22)), vis);
    bool party = isTube && (face == 2 || face == 1);         // tube houses: bare concrete side walls
    if (party) col = mix(col, sRGB(vec3(0.6, 0.58, 0.55)), 0.7) * (0.85 + 0.2 * hNoise(vec2(al, hh) * 0.4));
    vec3 glass = seed < 0.45 || isTube || isBlock ? sRGB(vec3(0.16, 0.2, 0.23))
               : seed < 0.7 ? sRGB(vec3(0.2, 0.42, 0.55)) : sRGB(vec3(0.24, 0.5, 0.36));
    float fl = floor(hh / flH), fy = hh - fl * flH;
    float m = 0.0;
    vec3 mc = glass;
    if ((face <= 2 || face == 8) && !party && hh > 0.0) {
      if (face == 0 && isTube) {
        if (fl < 0.5) { m = hBox(al, hh - 1.45, fw * 0.5 - 0.35, 1.45, pa, ph);               // roll-up shutter
                        mc = sRGB(vec3(0.42, 0.44, 0.45)) * (0.85 + 0.15 * step(0.5, fract(hh / 0.12))); }
        else { m = hBox(al, fy - 1.75, fw * 0.5 - 0.5, 0.75, pa, ph);                          // window band
               float rail = hBox(al, fy - 0.95, fw * 0.5 - 0.3, 0.05, pa, ph);
               mc = mix(glass, sRGB(vec3(0.85)), rail); m = max(m, rail); }
      } else if (face != 8) {
        float n = max(1.0, floor(fw / (isBlock ? 2.6 : 3.2)));
        float cell = fw / n;
        float ax = mod(al + fw * 0.5, cell) - cell * 0.5;
        m = hBox(ax, fy - 1.65, isBlock ? 0.8 : 0.55, 0.6, pa, ph);
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
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <begin_vertex>', VERT_BODY);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = hRough;');
  };
  mat.customProgramCacheKey = () => 'cuulong-houses-' + lod;
  return mat;
}

// ---------------------------------------------------------------- layer
export class HouseLayer extends GroupLayer {
  /** maxDistance: far models are hidden beyond it; nearR: detailed models within it (m from the camera). */
  constructor(meta, maxDistance, nearR = 1800) {
    super('buildings', meta);
    this.maxDistance = maxDistance;
    this.nearR = nearR;
    this.nStyles = meta.house_styles.length;
    this.nTiles = meta.house_tiles;
    this.span = meta.group * meta.grid_res_m;
    this.tileM = this.span / this.nTiles;
    this.models = houseModels();
    this.uniforms = { uNearR: { value: nearR }, uBex: { value: meta.building_exag } };
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
      const gy_ = (g[i] / 10) * ex - 0.3;
      iA.set([cx + x[i] / 2, gy_, -(cy + y[i] / 2), (ang[i] / 256) * Math.PI * 2], i * 4);
      iB.set([w[i] / 4, d[i] / 2, ht[i] / 4], i * 3);
      iC.set([style[i], kind[i], (Math.imul(i + 1, 2654435761) ^ Math.imul(gx * 7 + gy, 40503)) >>> 24, 0], i * 4);
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
      T.sphere = new THREE.Sphere(new THREE.Vector3(T.cx, (tMin + tMax) / 2, T.cz),
                                  this.tileM * 0.75 + (tMax - tMin) / 2 + 60);
      const { geometry } = this.instanced(this.models.far, data, first, start - first);
      geometry.boundingSphere = T.sphere;
      T.far = new THREE.Mesh(geometry, this.matFar);
      T.far.raycast = () => {};
      this.group.add(T.far);
      this.tiles.push(T);
    }
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

  buildTile(T) {
    const grp = new THREE.Group();
    const sphere = T.sphere;
    for (const [s, start, count] of T.ranges) {
      const { geometry } = this.instanced(this.models.near[s], T.data, start, count);
      geometry.boundingSphere = sphere;
      const m = new THREE.Mesh(geometry, this.matNear);
      m.raycast = () => {};
      grp.add(m);
    }
    this.group.add(grp);
    T.meshes = grp;
    this.built++;
  }

  disposeTile(T) {
    this.group.remove(T.meshes);
    for (const m of T.meshes.children) {        // detach the shared model buffers so only per-house buffers are freed
      for (const k of ['position', 'aOff', 'aK']) m.geometry.deleteAttribute(k);
      m.geometry.index = null;
      m.geometry.dispose();
    }
    T.meshes = null;
    this.built--;
  }

  update(camera) {
    this.frame++;
    const p = camera.position, half = this.tileM / 2, reach = this.nearR + 50;
    for (const T of this.tiles) {
      const dx = Math.max(Math.abs(p.x - T.cx) - half, 0), dz = Math.max(Math.abs(p.z - T.cz) - half, 0);
      const dy = p.y > T.yMax ? p.y - T.yMax : p.y < T.yMin ? T.yMin - p.y : 0;
      const dist = Math.hypot(dx, dy, dz);
      T.far.visible = dist < this.maxDistance;
      const near = dist < reach;
      if (near) {
        if (!T.meshes) this.buildTile(T);
        T.meshes.visible = true;
        T.used = this.frame;
      } else if (T.meshes) {
        T.meshes.visible = false;
      }
    }
    if (this.built > 24) {                       // free the least recently used tiles
      const old = this.tiles.filter((T) => T.meshes && T.used < this.frame).sort((a, b) => a.used - b.used);
      for (const T of old.slice(0, this.built - 24)) this.disposeTile(T);
    }
  }
}
