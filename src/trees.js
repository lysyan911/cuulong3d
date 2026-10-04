// Trees planted from the 10 m tree map (scripts/trees.py: ESA WorldCover tree cover + local species by zone).
//
//   near (< ~1 km): every tree, a real model per species built from leaf cards: coconut and areca fronds,
//                     sugar-palm (thốt nốt) fan crowns, banana leaves, bamboo clumps, nipa palms, tràm, fruit and
//                     shade trees. Foliage sways in the wind.
//   mid (to ~6 km):   one sprite tree per 30 m of canopy (crossed cards + a top card), species-correct.
//   beyond:           the satellite imagery already shows the canopy.
// CC0 photo foliage shares one 2K atlas (species silhouettes are adapted). Instances are generated per 3.84 km tile
// from the tree map when the camera comes near, so nothing is stored per tree.
import * as THREE from 'three';
import { photoTexture } from './photo-textures.js';
import { GLOBALS } from './render/globals.js';
import { cloudUniforms, patchCloudShadow } from './render/atmosphere.js';

const SPECIES = ['fruit', 'shade', 'coconut', 'areca', 'banana', 'bamboo', 'thotnot', 'tram', 'nipa', 'forest', 'shrub', 'boulder'];
const NS = SPECIES.length;
const S = Object.fromEntries(SPECIES.map((s, i) => [s, i]));
// expected trees per 10 m pixel of canopy (near)
const CH = 4;   // near chunks per tile side (960 m)
const DENSITY = [0.8, 0.22, 0.5, 0.7, 1.0, 0.3, 0.7, 1.5, 0.6, 0.85, 1.2, 0.8];
// foliage tint (linear multiplier on the leaf textures)
const TINT = [[0.78, 0.9, 0.7], [0.88, 1.0, 0.78], [1.08, 1.04, 0.72], [0.98, 1.0, 0.74], [1.15, 1.15, 0.68],
              [0.82, 1.0, 0.62], [0.82, 0.95, 0.8], [0.92, 0.94, 0.86], [0.98, 1.0, 0.7], [0.7, 0.84, 0.64],
              [0.86, 0.92, 0.62], [1, 1, 1]];

// ---------------------------------------------------------------- leaf atlas (canvas)
const AS = 2048;
const CELL = {
  white: [0, 0, 8, 8],
  broadSide: [16, 16, 480, 480], broadTop: [512, 16, 480, 480], tramSide: [1008, 16, 224, 480],
  bambooSide: [1248, 16, 384, 480], fan: [1648, 16, 384, 384],
  frond: [16, 512, 1008, 224], banana: [1040, 512, 640, 224],
  palmSprite: [16, 752, 480, 480], palmTop: [512, 752, 480, 480], thotnotSprite: [1008, 752, 320, 480],
  bananaSprite: [1344, 752, 320, 320], nipaSprite: [1680, 752, 352, 320], arecaSprite: [1680, 1088, 224, 480],
  rockSprite: [16, 1248, 256, 192],
};
const uvRect = ([x, y, w, h]) => [x / AS, 1 - (y + h) / AS, w / AS, h / AS];   // u0, v0, du, dv (flipY)

function makeAtlas() { return photoTexture('foliage/tree-atlas.webp'); }

// ---------------------------------------------------------------- model builder
class Model {
  constructor() { this.p = []; this.n = []; this.uv = []; this.part = []; this.col = []; this.quad = []; this.idx = []; this.v = 0; }
  vert(p, n, uv, part, col, quad = 0) {
    this.p.push(...p); this.n.push(...n); this.uv.push(...uv); this.part.push(part); this.col.push(...col); this.quad.push(quad);
    return this.v++;
  }
  // quad from 4 corners (counter-clockwise), uv rect, per-vertex normal fn
  quadP(c, rect, nfn, part, col, quadId = 0) {
    const [u0, v0, du, dv] = rect;
    const uvs = [[u0, v0], [u0 + du, v0], [u0 + du, v0 + dv], [u0, v0 + dv]];
    const ids = c.map((p, i) => this.vert(p, nfn(p), uvs[i], part, col, quadId));
    this.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
  }
  // vertical card around (x, z), facing angle a, from y0 to y1
  card(x, z, a, w, y0, y1, cell, centre, col, quadId = 0) {
    const dx = Math.cos(a) * w / 2, dz = Math.sin(a) * w / 2;
    this.quadP([[x - dx, y0, z - dz], [x + dx, y0, z + dz], [x + dx, y1, z + dz], [x - dx, y1, z - dz]],
               uvRect(CELL[cell]), sphereN(centre), 1, col, quadId);
  }
  top(x, z, size, y, cell, centre, col, a = 0, quadId = 0) {
    const c = Math.cos(a) * size / 2, s = Math.sin(a) * size / 2;
    this.quadP([[x - c + s, y, z - s - c], [x + c + s, y, z + s - c], [x + c - s, y, z + s + c], [x - c - s, y, z - s + c]],
               uvRect(CELL[cell]), centre ? sphereN(centre, 0.6) : () => [0, 1, 0], 1, col, quadId);
  }
  // tapered (optionally bent) trunk: open cylinder
  trunk(h, r0, r1, col, { bend = 0, segs = 6, rings = 4, y0 = 0 } = {}) {
    const rows = [];
    for (let k = 0; k <= rings; k++) {
      const t = k / rings, y = y0 + h * t, r = r0 + (r1 - r0) * t, ox = bend * t * t;
      const row = [];
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2, nx = Math.cos(a), nz = Math.sin(a);
        row.push(this.vert([ox + nx * r, y, nz * r], [nx, 0, nz], [0.5 / AS * 8, 1 - 0.5 / AS * 8], 0, col));
      }
      rows.push(row);
    }
    for (let k = 0; k < rings; k++) for (let i = 0; i < segs; i++) {
      const a = rows[k][i], b = rows[k][i + 1], c = rows[k + 1][i + 1], d = rows[k + 1][i];
      this.idx.push(a, c, b, a, d, c);
    }
    return [bend, y0 + h];
  }
  // frond / long leaf: strip from base along azimuth az, rising at elev, drooping; uv along the cell
  frond(base, az, elev, L, W, droop, cell, col, segs = 3) {
    const [u0, v0, du, dv] = uvRect(CELL[cell]);
    const hx = Math.cos(az), hz = Math.sin(az), px = -hz, pz = hx;
    const ids = [];
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const c = [base[0] + hx * L * t * Math.cos(elev), base[1] + L * t * Math.sin(elev) - droop * L * t * t,
                 base[2] + hz * L * t * Math.cos(elev)];
      const n = norm([hx * 0.35, 1, hz * 0.35]);
      const w = W / 2 * (k === 0 ? 0.4 : 1);
      ids.push(this.vert([c[0] - px * w, c[1], c[2] - pz * w], n, [u0 + du * t, v0], 1, col),
               this.vert([c[0] + px * w, c[1], c[2] + pz * w], n, [u0 + du * t, v0 + dv], 1, col));
    }
    for (let k = 0; k < segs; k++) {
      const a = ids[k * 2], b = ids[k * 2 + 1], c = ids[k * 2 + 3], d = ids[k * 2 + 2];
      this.idx.push(a, b, c, a, c, d);
    }
  }
  rock(col) {
    const src = new THREE.IcosahedronGeometry(1, 1).toNonIndexed(), P = src.attributes.position;
    const jit = (x, y, z) => { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return 0.72 + 0.5 * (h - Math.floor(h)); };
    const v = [];
    for (let q = 0; q < P.count; q++) {
      const x = P.getX(q), y = P.getY(q), z = P.getZ(q), k = jit(x.toFixed(3), y.toFixed(3), z.toFixed(3));
      v.push([x * k * 1.25, Math.max(y * k * 0.7, -0.3) + 0.05, z * k]);         // flattened, a third buried
    }
    const uvw = [0.5 / AS * 8, 1 - 0.5 / AS * 8];
    for (let q = 0; q < v.length; q += 3) {
      const [a, b, c] = [v[q], v[q + 1], v[q + 2]];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const f = norm([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
      // mostly rounded normals with a little faceting: weathered granite, not crystal
      const ids = [a, b, c].map((p) => { const r = norm([p[0], p[1] + 0.3, p[2]]);
        return this.vert(p, norm([f[0] * 0.35 + r[0], f[1] * 0.35 + r[1], f[2] * 0.35 + r[2]]), uvw, 2, col); });
      this.idx.push(...ids);
    }
  }
  geometry() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aQuad', new THREE.Float32BufferAttribute(this.quad, 1));
    g.setIndex(this.idx);
    return g;
  }
}
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const sphereN = (c, up = 0.35) => (p) => norm([p[0] - c[0], (p[1] - c[1]) + up * 3, p[2] - c[2]]);

const BARK = { dark: [0.11, 0.08, 0.06], pale: [0.52, 0.49, 0.44], palm: [0.24, 0.2, 0.16], areca: [0.36, 0.37, 0.31],
               sugar: [0.08, 0.07, 0.06], stem: [0.2, 0.3, 0.09], granite: [0.17, 0.16, 0.145] };
const ONE = [1, 1, 1], DEAD = [1.25, 0.8, 0.4];

function speciesModels() {
  const M = [];
  const broad = (trunkH, trunkR, cy, w, h, tops) => {
    const m = new Model();
    m.trunk(trunkH, trunkR, trunkR * 0.6, BARK.dark, { rings: 1 });
    const c = [0, cy, 0];
    for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) m.card(0, 0, a, w, cy - h / 2, cy + h / 2, 'broadSide', c, ONE);
    tops.forEach(([y, s], i) => m.top(0, 0, s, y, 'broadTop', c, ONE, i * 0.9));
    return m.geometry();
  };
  M[S.fruit] = broad(2.6, 0.22, 5.2, 7.0, 6.0, [[6.4, 6.6]]);
  M[S.shade] = broad(6.5, 0.4, 11.5, 14, 9, [[12.5, 13], [14.2, 8.5]]);
  { const m = new Model();                       // hill forest: uneven crown of three clumps on a leaning trunk
    m.trunk(6, 0.3, 0.16, BARK.dark, { rings: 2, bend: 0.8 });
    const c = [0.4, 9.5, 0];
    for (const [ox, oz, cy, w, h] of [[0.4, 0, 9.5, 8, 7], [-2.2, 1.4, 7.6, 5.2, 4.6], [2.4, -1.6, 8.2, 5.6, 5]]) {
      for (const a of [0.3, 1.35, 2.4]) m.card(ox, oz, a, w, cy - h / 2, cy + h / 2, 'broadSide', c, ONE);
      m.top(ox, oz, w * 0.95, cy + h * 0.18, 'broadTop', c, ONE, ox);
    }
    M[S.forest] = m.geometry(); }
  { const m = new Model();                       // shrub / scrub bush on open hill slopes
    const c = [0, 1.0, 0];
    for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) m.card(0, 0, a, 3.2, -0.2, 2.3, 'broadSide', c, ONE);
    m.top(0, 0, 3.0, 1.7, 'broadTop', c, ONE);
    M[S.shrub] = m.geometry(); }
  { const m = new Model();                       // granite boulder (solid, not a leaf card)
    m.rock(BARK.granite);
    M[S.boulder] = m.geometry(); }
  { const m = new Model(); m.trunk(10, 0.17, 0.1, BARK.pale, { rings: 1 });
    const c = [0, 11, 0];
    m.card(0, 0, 0, 4.4, 5.5, 15, 'tramSide', c, ONE); m.card(0, 0, Math.PI / 2, 4.4, 5.5, 15, 'tramSide', c, ONE);
    m.top(0, 0, 4.0, 13.0, 'broadTop', c, ONE);
    M[S.tram] = m.geometry(); }
  const palm = (h, r0, r1, bend, n, L, W, bark, dead = 2, droop = 0.45) => {
    const m = new Model();
    const [tx, ty] = m.trunk(h, r0, r1, bark, { bend, rings: 3, segs: 5 });
    const base = [tx, ty, 0];
    for (let i = 0; i < n; i++) {
      const az = (i / n) * Math.PI * 2 + (i % 2) * 0.25, elev = 0.85 - (i % 3) * 0.45;
      m.frond(base, az, elev, L * (0.85 + (i % 3) * 0.1), W, droop, 'frond', ONE);
    }
    for (let i = 0; i < dead; i++) m.frond([tx, ty - 0.3, 0], i * 2.4 + 0.5, -1.1, L * 0.7, W * 0.8, 0.05, 'frond', DEAD);
    return m.geometry();
  };
  M[S.coconut] = palm(12, 0.22, 0.15, 1.6, 11, 5.2, 1.4, BARK.palm, 1);
  M[S.areca] = palm(11, 0.1, 0.09, 0.15, 7, 2.6, 0.85, BARK.areca, 0, 0.35);
  { const m = new Model();                       // nipa: fronds straight from the mud, no trunk
    for (let i = 0; i < 8; i++) m.frond([0, 0.1, 0], (i / 8) * Math.PI * 2, 1.15 - (i % 2) * 0.2, 5.5, 1.2, 0.32, 'frond', ONE);
    M[S.nipa] = m.geometry(); }
  { const m = new Model();                       // thốt nốt: tall straight trunk, dense ball of fan leaves (~7 m)
    m.trunk(15.5, 0.32, 0.24, BARK.sugar, { rings: 1, segs: 5 });
    const c = [0, 17.4, 0];
    for (let i = 0; i < 26; i++) {
      const phi = Math.acos(1 - 2 * ((i + 0.5) / 26)), th = i * 2.4;
      const d = [Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)];
      const p = [d[0] * 2.9, c[1] + d[1] * 2.2, d[2] * 2.9];
      const a = Math.atan2(d[2], d[0]) + Math.PI / 2;
      m.card(p[0], p[2], a, 4.2, p[1] - 2.0, p[1] + 2.0, 'fan', c, i % 9 === 4 ? DEAD : ONE);
    }
    for (let i = 0; i < 6; i++) {                 // skirt of dead fronds hanging under the crown
      const th = i * 1.047 + 0.3;
      m.card(Math.cos(th) * 1.1, Math.sin(th) * 1.1, th + Math.PI / 2, 2.6, c[1] - 3.6, c[1] - 1.6, 'fan', c, DEAD);
    }
    M[S.thotnot] = m.geometry(); }
  { const m = new Model();                       // banana: green pseudo-stem, big arching leaves
    m.trunk(2.0, 0.13, 0.1, BARK.stem, { rings: 1, segs: 5 });
    for (let i = 0; i < 6; i++) m.frond([0, 1.9, 0], i * 1.05, 0.9 - (i % 3) * 0.3, 2.6, 0.8, 0.5, 'banana', ONE, 2);
    M[S.banana] = m.geometry(); }
  { const m = new Model();                       // bamboo clump
    const c = [0, 6, 0];
    for (let i = 0; i < 4; i++) m.card(0, 0, (i / 4) * Math.PI, 7, 0, 12.5, 'bambooSide', c, ONE);
    m.top(0, 0, 6, 10.5, 'broadTop', c, [0.95, 1.05, 0.7]);
    M[S.bamboo] = m.geometry(); }
  return M;
}

// mid: two crossed sprite cards + one top card; the cell per species is chosen in the shader
const SPRITE = {   // side cell, top cell, width, height
  fruit: ['broadSide', 'broadTop', 7, 8], shade: ['broadSide', 'broadTop', 14, 15], coconut: ['palmSprite', 'palmTop', 9, 13.5],
  areca: ['arecaSprite', 'palmTop', 4.5, 12], banana: ['bananaSprite', 'palmTop', 4.5, 4], bamboo: ['bambooSide', 'broadTop', 7, 12.5],
  thotnot: ['thotnotSprite', 'fan', 6, 19], tram: ['tramSide', 'broadTop', 3.6, 14], nipa: ['nipaSprite', 'palmTop', 6.5, 5.5],
  forest: ['broadSide', 'broadTop', 10, 12], shrub: ['broadSide', 'broadTop', 3.2, 2.4], boulder: ['rockSprite', 'rockSprite', 2.6, 1.8],
};
function midModel() {
  const m = new Model();
  const c = [0, 0.55, 0];
  const unit = [0, 0, 1, 1];
  const q = (corners, n, quadId) => m.quadP(corners, unit, n, 1, ONE, quadId);
  q([[-0.5, 0, 0], [0.5, 0, 0], [0.5, 1, 0], [-0.5, 1, 0]], sphereN(c), 0);
  q([[0, 0, -0.5], [0, 0, 0.5], [0, 1, 0.5], [0, 1, -0.5]], sphereN(c), 0);
  q([[-0.5, 0.8, -0.5], [0.5, 0.8, -0.5], [0.5, 0.8, 0.5], [-0.5, 0.8, 0.5]], () => [0, 1, 0], 1);
  return m.geometry();
}

// ---------------------------------------------------------------- material
function treeMaterial(atlas, lod, uniforms) {
  const mat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85,
                                              metalness: 0, alphaToCoverage: true });
  mat.defines = { [lod]: '' };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPart; attribute vec3 aColor; attribute float aQuad;
        attribute vec4 iP; attribute vec4 iS;     // x, y, z, rotation | scale, tint, phase, species
        uniform float uTime, uNearR, uFarR, uBex; uniform vec3 uViewPos;
        uniform vec4 uSide[${NS}]; uniform vec4 uTop[${NS}]; uniform vec2 uSize[${NS}]; uniform vec3 uTint[${NS}];
        varying vec3 vTint; varying float vPart; varying float vRingY; varying float iSeedR;`)
      .replace('#include <beginnormal_vertex>', `
        float ncs = cos(iP.w), nsn = sin(iP.w);
        vec3 objectNormal = vec3(ncs * normal.x + nsn * normal.z, normal.y, -nsn * normal.x + ncs * normal.z);`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef MID
          int spc = int(iS.w + 0.5);
          vec4 cellR = aQuad < 0.5 ? uSide[spc] : uTop[spc];
          vMapUv = cellR.xy + uv * cellR.zw;
        #endif`)
      .replace('#include <begin_vertex>', `
        float tc = cos(iP.w), ts = sin(iP.w);
        float dist = distance(uViewPos, iP.xyz);
        float sc = iS.x * mix(1.0, uBex, smoothstep(1500.0, 6000.0, dist));
        #ifdef MID
          int sp = int(iS.w + 0.5);
          vec3 p = position * vec3(uSize[sp].x, uSize[sp].y, uSize[sp].x) * sc;
          vTint = uTint[sp] * iS.y;
        #else
          vec3 p = position * sc;
          vTint = (aPart > 0.5 ? uTint[int(iS.w + 0.5)] * aColor : aColor) * iS.y;
        #endif
        vPart = aPart;
        vRingY = position.y;
        iSeedR = iS.z;
        float sway = step(0.5, aPart) * step(aPart, 1.5) * (sin(uTime * 1.5 + iS.z * 6.283 + p.y * 0.12) * 0.6 + sin(uTime * 2.6 + iS.z * 3.7) * 0.3);
        p.x += sway * 0.010 * p.y; p.z += sway * 0.007 * p.y;
        vec3 transformed = iP.xyz + vec3(tc * p.x + ts * p.z, p.y, -ts * p.x + tc * p.z);
        #ifdef MID
          if (dist <= uNearR || dist > uFarR) transformed = vec3(0.0);
        #else
          if (dist > uNearR) transformed = vec3(0.0);
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTint; varying float vPart; varying float vRingY; varying float iSeedR;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= vTint;
        #ifdef MID
          // a sprite crown is lit like its sunny top: darken for the shade inside it, more as crowns merge into forest
          diffuseColor.rgb *= vec3(0.60, 0.64, 0.66) * mix(1.0, 0.72, smoothstep(1200.0, 4000.0, length(vViewPosition)));
        #endif
        if (vPart < 0.5) diffuseColor.rgb *= 0.82 + 0.18 * step(0.5, fract(vRingY * 1.6));   // trunk rings
        if (vPart > 1.5) diffuseColor.rgb *= mix(vec3(0.75, 0.82, 0.62), vec3(1.15), smoothstep(0.1, 0.6, vRingY)) * (0.85 + 0.3 * fract(iSeedR * 7.3));`)
      .replace('#include <alphatest_fragment>', `
        // Apply identical mip coverage in colour and shadow passes.
        float mip = max(0.0, log2(max(fwidth(vMapUv.x), fwidth(vMapUv.y)) * 2048.0));
        diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + 0.6 * mip));
        #include <alphatest_fragment>`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        if (vPart > 0.5 && vPart < 1.5) normal = normalize(vNormal);    // leaves: crown-shaped normals, both sides lit alike`);
  };
  mat.customProgramCacheKey = () => 'cuulong-trees-' + lod;
  const compile = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh) => { compile(sh); patchCloudShadow(sh, cloudUniforms()); };
  // shadow pass: same placement and leaf cut-outs (the colour/normal edits find nothing to replace there)
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.45,
                                              side: THREE.DoubleSide });
  depth.defines = { [lod]: '' };
  depth.onBeforeCompile = compile;
  depth.customProgramCacheKey = () => 'cuulong-trees-depth-' + lod;
  mat.userData.depthMaterial = depth;
  return mat;
}

// ---------------------------------------------------------------- layer
const MODEL_HEIGHT = { fruit: 8, shade: 15, coconut: 13.5, areca: 12, banana: 4, bamboo: 12.5, thotnot: 19, tram: 14,
                       nipa: 5.5, forest: 12, shrub: 2.4, boulder: 1.8 };   // m at scale 1 (as the mid sprites)

export class TreeLayer {
  /** terrain: for ground heights; nearR: full trees within (m); farR: sprite trees within (m). */
  constructor(meta, terrain, shared, { dataUrl = 'data/', nearR = 1000, farR = 6000 } = {}) {
    this.meta = meta;
    this.terrain = terrain;
    this.dataUrl = dataUrl;
    this.group = new THREE.Group();
    this.group.name = 'trees';
    this.nearR = nearR;
    this.farR = farR;
    const atlas = makeAtlas();
    const sp = SPECIES.map((s) => SPRITE[s]);
    this.uniforms = {
      uTime: shared.uTime, uNearR: { value: nearR }, uFarR: { value: farR }, uBex: { value: meta.building_exag },
      uViewPos: GLOBALS.uViewPos,
      uSide: { value: sp.map(([c]) => new THREE.Vector4(...uvRect(CELL[c]))) },
      uTop: { value: sp.map(([, c]) => new THREE.Vector4(...uvRect(CELL[c]))) },
      uSize: { value: sp.map(([, , w, h]) => new THREE.Vector2(w, h)) },
      uTint: { value: TINT.map((t) => new THREE.Vector3(...t)) },
    };
    this.matNear = treeMaterial(atlas, 'NEAR', this.uniforms);
    this.matMid = treeMaterial(atlas, 'MID', this.uniforms);
    this.models = speciesModels();
    this.mid = midModel();
    const res = meta.grid_res_m, span = meta.group * res;
    this.tileM = meta.tile * res;
    this.tiles = (meta.tree_tiles || []).map(([gx, gy, tx, ty]) => {
      const x0 = -meta.width_m / 2 + (gx * meta.group + 0.5) * res + tx * this.tileM;
      const y0 = meta.height_m / 2 - (gy * meta.group + 0.5) * res - ty * this.tileM;   // north edge
      return { key: `${gx}_${gy}_${tx}_${ty}`, x0, y0, cx: x0 + this.tileM / 2, cz: -(y0 - this.tileM / 2),
               ground: terrain.heightAt(x0 + this.tileM / 2, y0 - this.tileM / 2) * meta.vert_exag,
               state: 0, px: null, midMesh: null, chunks: null, used: 0 };
    });
    void span;
    this.loading = 0;
    this.frame = 0;
  }

  async load(T) {
    T.state = 1;
    this.loading++;
    try {
      const blob = await fetch(`${this.dataUrl}trees/t_${T.key}.png`).then((r) => r.blob());
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      T.n = bmp.width;
      T.px = new Uint8Array(T.n * T.n);
      for (let i = 0; i < T.px.length; i++) T.px[i] = rgba[i * 4];
      T.state = 2;
    } catch (e) {
      console.warn('tree tile', T.key, e);
      T.state = 3;
    }
    this.loading--;
  }

  // instances: iP (x, y, z, rot), iS (scale, tint, phase, species)
  instances(T, near, chunk = null) {
    const n = T.n, cell = this.tileM / n, ex = this.meta.vert_exag, P = [], Sv = [], perSpecies = near ? SPECIES.map(() => []) : null;
    const hash = (a, b) => { let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const add = (x, yN, sp, scale, k) => {
      if (this.terrain.wetland && this.terrain.wetland.floodAt(x, yN) > .6) return;
      const water = this.terrain.surface;
      if (water && water.waterAt(x, yN) > 0.65 && water.shoreAt(x, yN) < -12) return;
      const y = this.terrain.heightAt(x, yN) * ex - 0.2;
      const rec = [x, y, -yN, hash(k, 3) * Math.PI * 2, scale, 0.82 + hash(k, 4) * 0.36, hash(k, 5), sp];
      if (near) perSpecies[sp].push(rec); else { P.push(rec); }
    };
    const gx0 = Math.round(T.x0 / cell), gy0 = Math.round(T.y0 / cell);   // global pixel ids for stable hashes
    if (near) {
      const cs = n / CH, r0 = chunk[1] * cs, c0 = chunk[0] * cs;
      for (let r = r0; r < r0 + cs; r++) for (let c = c0; c < c0 + cs; c++) {
        const v = T.px[r * n + c];
        if (!v) continue;
        const sp = v - 1, k = (gy0 - r) * 100003 + (gx0 + c);
        const cnt = Math.floor(DENSITY[sp] + hash(k, 1));
        for (let j = 0; j < cnt; j++) {
          const kk = k * 7 + j;
          add(T.x0 + (c + hash(kk, 8)) * cell, T.y0 - (r + hash(kk, 9)) * cell, sp, 0.75 + hash(kk, 2) * 0.55, kk);
        }
      }
      return perSpecies;
    }
    const B = 3;                                  // one sprite per 30 m of canopy
    for (let r = 0; r < n; r += B) for (let c = 0; c < n; c += B) {
      let cnt = 0, sp = -1;
      const k = (gy0 - r) * 100003 + (gx0 + c);
      for (let i = 0; i < B; i++) for (let j = 0; j < B; j++) {
        const v = r + i < n && c + j < n ? T.px[(r + i) * n + c + j] : 0;
        if (v) { cnt++; if (sp < 0 || hash(k, i * 3 + j) < 0.3) sp = v - 1; }
      }
      if (!cnt || hash(k, 11) > 0.25 + cnt / (B * B)) continue;
      add(T.x0 + (c + B * hash(k, 8)) * cell, T.y0 - (r + B * hash(k, 9)) * cell, sp,
          (0.8 + hash(k, 2) * 0.4) * (0.85 + 0.25 * Math.min(cnt, 6) / 6), k);
    }
    void Sv;
    return P;
  }

  mesh(model, recs, mat, T, sphere = null) {
    const n = recs.length, iP = new Float32Array(n * 4), iS = new Float32Array(n * 4);
    recs.forEach((r, i) => { iP.set(r.slice(0, 4), i * 4); iS.set(r.slice(4, 8), i * 4); });
    const g = new THREE.InstancedBufferGeometry();
    g.index = model.index;
    for (const k of ['position', 'normal', 'uv', 'aPart', 'aColor', 'aQuad']) g.setAttribute(k, model.attributes[k]);
    g.setAttribute('iP', new THREE.InstancedBufferAttribute(iP, 4));
    g.setAttribute('iS', new THREE.InstancedBufferAttribute(iS, 4));
    g.instanceCount = n;
    g.boundingSphere = sphere || new THREE.Sphere(new THREE.Vector3(T.cx, T.ground, T.cz), this.tileM * 0.75 + 400);
    const m = new THREE.Mesh(g, mat);
    m.raycast = () => {};
    m.frustumCulled = true;
    return m;
  }

  /**
   * Hand-placed trees (e.g. web/data/long-xuyen-greenery.json: [{x, y (north), species, height_m}]): one near and one
   * mid mesh per list, same models and materials as the mapped trees. Trees on water are skipped.
   */
  placed(list) {
    const ex = this.meta.vert_exag, water = this.terrain.surface, recs = [];
    let k = 0;
    for (const t of list) {
      const sp = SPECIES.indexOf(t.species);
      if (sp < 0 || (water && water.waterAt(t.x, t.y) > 0.5)) continue;
      const y = this.terrain.heightAt(t.x, t.y) * ex - 0.2, sc = (t.height_m || MODEL_HEIGHT[t.species]) / MODEL_HEIGHT[t.species];
      recs.push([t.x, y, -t.y, (k * 2.399) % 6.283, sc, 0.9 + (k % 7) * 0.03, (k * 0.618) % 1, sp]);
      k++;
    }
    const g = new THREE.Group();
    g.name = 'placed-trees';
    if (!recs.length) return g;
    const cx = recs.reduce((a, r) => a + r[0], 0) / recs.length, cz = recs.reduce((a, r) => a + r[2], 0) / recs.length;
    const R = Math.max(...recs.map((r) => Math.hypot(r[0] - cx, r[2] - cz))) + 30;
    const sphere = new THREE.Sphere(new THREE.Vector3(cx, recs[0][1], cz), R);
    const T = { cx, ground: recs[0][1], cz };
    SPECIES.forEach((_, sp) => {
      const r = recs.filter((q) => q[7] === sp);
      if (r.length) g.add(this.mesh(this.models[sp], r, this.matNear, T, sphere));
    });
    const mid = this.mesh(this.mid, recs, this.matMid, T, sphere);
    mid.userData.noShadow = true;
    g.add(mid);
    return g;
  }

  dispose(obj) {
    if (!obj) return;
    this.group.remove(obj);
    obj.traverse((m) => {
      if (!m.isMesh) return;
      for (const k of ['position', 'normal', 'uv', 'aPart', 'aColor', 'aQuad']) m.geometry.deleteAttribute(k);
      m.geometry.index = null;
      m.geometry.dispose();
    });
  }

  update(camera) {
    this.frame++;
    if (!this.group.visible) return;
    const p = camera.position, half = this.tileM / 2;
    // The flooded forest has its own close-up trees. Outside its boundary, sprites
    // are sufficient through the 650 m forest haze; don't submit invisible village crowns.
    const wet = this.terrain.wetland;
    const immersed = wet && p.y < wet.level + 80 && wet.floodAt(p.x, -p.z) > .8;
    const nearR = immersed ? 0 : this.nearR, farR = immersed ? Math.min(650, this.farR) : this.farR;
    this.uniforms.uNearR.value = nearR; this.uniforms.uFarR.value = farR;
    const want = [];
    for (const T of this.tiles) {
      const dx = Math.max(Math.abs(p.x - T.cx) - half, 0), dz = Math.max(Math.abs(p.z - T.cz) - half, 0);
      const d = Math.hypot(dx, dz, Math.max(p.y - T.ground - 60, 0));
      if (d < farR + 200) {
        T.used = this.frame;
        if (T.state === 0) want.push([d, T]);
        if (T.state === 2) {
          if (!T.midMesh) { T.midMesh = this.mesh(this.mid, this.instances(T, false), this.matMid, T); T.midMesh.userData.noShadow = true; this.group.add(T.midMesh); }
          T.midMesh.visible = true;
          // full trees per chunk (CH x CH per tile), only the chunks within reach exist
          T.chunks ||= new Map();
          const cm = this.tileM / CH;
          for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CH; cx++) {
            const ccx = T.x0 + (cx + 0.5) * cm, ccz = -(T.y0 - (cy + 0.5) * cm), key = cy * CH + cx;
            const ddx = Math.max(Math.abs(p.x - ccx) - cm / 2, 0), ddz = Math.max(Math.abs(p.z - ccz) - cm / 2, 0);
            const inReach = nearR > 0 && d < nearR + 50 && Math.hypot(ddx, ddz, Math.max(p.y - T.ground - 60, 0)) < nearR + 50;
            let g = T.chunks.get(key);
            if (inReach && !g) {
              g = new THREE.Group();
              const sphere = new THREE.Sphere(new THREE.Vector3(ccx, T.ground, ccz), cm * 0.75 + 300);
              this.instances(T, true, [cx, cy]).forEach((recs, sp) => {
                if (recs.length) g.add(this.mesh(this.models[sp], recs, this.matNear, T, sphere));
              });
              this.group.add(g);
              T.chunks.set(key, g);
            } else if (!inReach && g) {
              this.dispose(g); T.chunks.delete(key);
            }
          }
        }
      } else {
        if (T.midMesh) { this.dispose(T.midMesh); T.midMesh = null; }
        if (T.chunks) { for (const g of T.chunks.values()) this.dispose(g); T.chunks.clear(); }
        if (T.state === 2 && this.frame - T.used > 600) { T.px = null; T.state = 0; }   // forget the map after a while
      }
    }
    want.sort((a, b) => a[0] - b[0]);
    for (const [, T] of want) { if (this.loading >= 4) break; this.load(T); }
  }
}
