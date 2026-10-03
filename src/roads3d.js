// 3D roads: OSM roads as real-width ribbons draped on the terrain, shaped like Mekong delta roads.
//
//   cross-section  sloped grassy embankment | shoulder (towns: raised tiled sidewalk behind a kerb) | road | ...
//                  rural roads sit on dykes (higher beside canals), highways on tall embankments, town streets at grade
//   surfaces       asphalt with white edge lines and a dashed centre line (double yellow + lane lines on 4 lanes);
//                  rural concrete roads in slabs with joints; dirt tracks with wheel ruts; wooden footbridges
//   bridges        arched decks over canals (flat-topped for long spans), railings, pier walls down to the water
// Ribbons are built per 3.84 km terrain tile near the camera (scripts/roads.py writes the polylines); beyond ~4 km
// the hybrid-map lines (world.js RoadLayer) fade back in. Town streets also get their street life (streets.js).
import * as THREE from 'three';
import { groupCentre } from './world.js';
import { cloudUniforms, patchCloudShadow } from './render/atmosphere.js';

const ASPHALT = 0, WOOD = 3;          // surfaces: 0 asphalt, 1 concrete, 2 dirt, 3 wood
const BRIDGE = 1, TOWN = 2, DYKE = 4;
const PART = { road: 0, shoulder: 1, slope: 2, rail: 3, pier: 4, walk: 5, kerb: 6 };
const KERB = 0.18;                     // town sidewalks stand this much above the street

/** Embankment height (m) above the fields by class (0 motorway .. 8 path) and flags. */
function embankment(cls, flags) {
  if (flags & TOWN) return 0.15;
  const dyke = flags & DYKE;
  if (cls <= 2) return 1.8;
  if (cls <= 4) return 1.3;
  if (cls <= 6) return dyke ? 1.1 : 0.6;
  if (cls === 7) return dyke ? 0.8 : 0.4;
  return dyke ? 0.6 : 0.25;
}

const VERT = /* glsl */`
attribute vec2 aUV;      // along (m), across (m from the centre line)
attribute vec4 aInfo;    // half width, surface, lanes (0 = no markings), part
uniform float uFarR;
varying vec2 vRoadUV;
varying vec4 vInfo;
varying float vDist;
`;
const FRAG = /* glsl */`
uniform float uFarR;
varying vec2 vRoadUV;
varying vec4 vInfo;
varying float vDist;
float rHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rHash(i), rHash(i + vec2(1, 0)), f.x), mix(rHash(i + vec2(0, 1)), rHash(i + vec2(1, 1)), f.x), f.y);
}
// anti-aliased stripe of half width w centred on c
float stripe(float x, float c, float w, float px) { return 1.0 - smoothstep(w - px, w + px, abs(x - c)); }
vec3 sRGBr(vec3 c) { return pow(c, vec3(2.2)); }
`;
const FRAG_COLOR = /* glsl */`
  if (vDist > uFarR) discard;
  float along = vRoadUV.x, ac = vRoadUV.y, hw = vInfo.x;
  int surf = int(vInfo.y + 0.5), part = int(vInfo.w + 0.5);
  float lanes = vInfo.z;
  float pa = max(fwidth(along), 1e-4), pc = max(fwidth(ac), 1e-4);
  float vis = 1.0 - smoothstep(0.12, 0.5, max(pa, pc));
  float n1 = rNoise(vec2(along, ac) * 0.5), n2 = rNoise(vec2(along, ac) * 3.1);
  vec3 col;
  float rough = 0.9;
  if (part == 0) {
    if (surf == 0) {                                                       // asphalt
      col = sRGBr(vec3(0.33, 0.33, 0.34)) * (0.82 + 0.22 * n1 + 0.08 * n2);
      float wheel = lanes > 0.5 ? exp(-pow((abs(ac) - hw * 0.5) / (hw * 0.18), 2.0)) : 0.0;
      col *= 1.0 - 0.12 * wheel;
      if (lanes > 0.5) {
        float m = stripe(abs(ac), hw - 0.35, 0.08, pc);                    // edge lines
        vec3 mc = vec3(0.8);
        if (lanes < 2.5) {
          m = max(m, stripe(ac, 0.0, 0.07, pc) * step(fract(along / 10.0), 0.5));      // dashed centre line
        } else {
          float y = stripe(abs(ac), 0.16, 0.07, pc);                                     // double yellow
          m = max(m, y);
          if (y > 0.01) mc = sRGBr(vec3(0.85, 0.66, 0.12));
          m = max(m, stripe(abs(ac), hw * 0.5, 0.07, pc) * step(fract(along / 10.0), 0.5));
        }
        col = mix(col, mc, m * vis);
      }
    } else if (surf == 1) {                                                // concrete slabs with joints
      float slab = rHash(vec2(floor(along / 4.5), floor(ac / max(hw, 0.5))));
      col = sRGBr(vec3(0.68, 0.67, 0.63)) * (0.86 + 0.1 * slab + 0.07 * n2) * (0.92 + 0.12 * n1);
      float j = stripe(fract(along / 4.5 + 0.5) * 4.5, 2.25, 0.02, pa);
      if (hw > 2.4) j = max(j, stripe(ac, 0.0, 0.02, pc));
      col *= 1.0 - 0.45 * j * vis;
      col = mix(col, sRGBr(vec3(0.5, 0.44, 0.36)), smoothstep(hw - 0.3, hw, abs(ac)) * 0.5);   // muddy edges
    } else if (surf == 2) {                                                // dirt track with ruts
      col = sRGBr(vec3(0.5, 0.41, 0.31)) * (0.78 + 0.3 * n1 + 0.06 * n2);
      float rut = exp(-pow((abs(ac) - min(0.75, hw * 0.55)) / 0.22, 2.0));
      col *= 1.0 - 0.28 * rut * vis;
      col = mix(col, sRGBr(vec3(0.32, 0.38, 0.2)), smoothstep(0.62, 0.8, rNoise(vec2(along * 0.4, ac * 2.0))) * 0.6 * (1.0 - rut));
    } else {                                                               // wooden planks
      col = sRGBr(vec3(0.46, 0.34, 0.23)) * (0.78 + 0.25 * step(0.5, fract(along / 0.24 + rHash(vec2(floor(along / 0.24), 1.0)))));
      col *= 1.0 - 0.4 * stripe(fract(along / 0.24) * 0.24, 0.0, 0.015, pa) * vis;
    }
  } else if (part == 1) {                                                  // grass / dirt shoulder
    col = mix(sRGBr(vec3(0.44, 0.40, 0.29)), sRGBr(vec3(0.33, 0.40, 0.2)), n1) * (0.85 + 0.15 * n2);
  } else if (part == 5) {                                                  // town sidewalk: paving tiles
    float kind = rHash(vec2(floor(along / 60.0), sign(ac)));               // tile colours change along the street
    vec3 tileC = kind < 0.4 ? vec3(0.62, 0.42, 0.36) : kind < 0.75 ? vec3(0.62, 0.58, 0.52) : vec3(0.68, 0.6, 0.42);
    col = sRGBr(tileC) * (0.86 + 0.14 * rHash(floor(vec2(along, ac) / 0.4)));
    col *= 1.0 - 0.3 * max(stripe(fract(along / 0.4) * 0.4, 0.0, 0.01, pa), stripe(fract(ac / 0.4) * 0.4, 0.0, 0.01, pc)) * vis;
    col *= 0.8 + 0.2 * smoothstep(0.2, 0.7, rNoise(vec2(along, ac) * 0.35));   // grime and wet patches
  } else if (part == 6) {                                                  // kerb stones
    col = sRGBr(vec3(0.72, 0.71, 0.68)) * (0.85 + 0.15 * rHash(vec2(floor(along / 1.0), 3.0)));
  } else if (part == 2) {                                                  // grassy embankment
    col = sRGBr(vec3(0.3, 0.4, 0.17)) * (0.72 + 0.35 * n1 + 0.1 * n2);
  } else if (part == 3) {                                                  // railing
    col = surf == 3 ? sRGBr(vec3(0.42, 0.32, 0.22)) : sRGBr(vec3(0.8, 0.8, 0.77));
    col *= 1.0 - 0.3 * stripe(fract(along / 2.0) * 2.0, 0.0, 0.08, pa) * vis;
    rough = 0.7;
  } else {                                                                 // pier
    col = surf == 3 ? sRGBr(vec3(0.3, 0.23, 0.16)) : sRGBr(vec3(0.55, 0.55, 0.52));
  }
  diffuseColor.rgb = col;
`;

function roadMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, flatShading: true, side: THREE.DoubleSide,
                                              polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vDist = distance(cameraPosition, position);
        transformed.y += 0.08 + 0.0012 * vDist;      // stay above coarser terrain far away
        vRoadUV = aUV; vInfo = aInfo;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR);
    patchCloudShadow(sh, cloudUniforms());
  };
  mat.customProgramCacheKey = () => 'cuulong-roads3d-clouds';
  return mat;
}

export class Road3DLayer {
  /** terrain: ground heights; farR: ribbons within this distance (m); streets: optional StreetFurniture. */
  constructor(meta, terrain, { farR = 4000, streets = null } = {}) {
    this.streets = streets;
    this.meta = meta;
    this.terrain = terrain;
    this.farR = farR;
    this.group = new THREE.Group();
    this.group.name = 'roads3d';
    this.uniforms = { uFarR: { value: farR } };
    this.material = roadMaterial(this.uniforms);
    this.span = meta.group * meta.grid_res_m;
    this.tileM = meta.tile * meta.grid_res_m;
    this.tiles = [];
  }

  async loadCell(gx, gy, url) {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    const dv = new DataView(buf);
    const n = dv.getInt32(0, true), nPts = dv.getInt32(4, true);
    const NT = 7, tileCounts = new Uint32Array(buf, 8, NT * NT);
    let o = 8 + NT * NT * 4;
    const npts = new Uint16Array(buf, o, n); o += n * 2;
    const u8 = () => { const a = new Uint8Array(buf, o, n); o += n; return a; };
    const cls = u8(), width = u8(), surface = u8(), flags = u8(), lanes = u8();
    if (o % 2) o++;
    const xy = new Int16Array(buf, o, nPts * 2);
    const starts = new Uint32Array(n);
    for (let i = 1; i < n; i++) starts[i] = starts[i - 1] + npts[i - 1];
    const [cx, cy] = groupCentre(this.meta, gx, gy);
    const data = { cx, cy, npts, starts, cls, width, surface, flags, lanes, xy };
    let first = 0;
    for (let t = 0; t < NT * NT; t++) {
      const count = tileCounts[t];
      if (count) {
        const tx = t % NT, ty = Math.floor(t / NT);
        const tcx = cx - this.span / 2 + (tx + 0.5) * this.tileM, tcy = cy + this.span / 2 - (ty + 0.5) * this.tileM;
        this.tiles.push({ data, first, count, cx: tcx, cz: -tcy, ground: this.terrain.heightAt(tcx, tcy) * this.meta.vert_exag,
                          mesh: null });
      }
      first += count;
    }
  }

  build(T) {
    const D = T.data, ex = this.meta.vert_exag;
    const pos = [], uv = [], info = [], idx = [], townRoads = [];
    let v = 0;
    const vert = (x, y, yN, along, across, hw, surf, lanes, part) => {
      pos.push(x, y, -yN); uv.push(along, across); info.push(hw, surf, lanes, part);
      return v++;
    };
    // strip between consecutive cross-section points a and b (lists of vertex ids)
    const strip = (A, B) => { for (let k = 0; k < A.length - 1; k++) idx.push(A[k], B[k], B[k + 1], A[k], B[k + 1], A[k + 1]); };

    for (let c = T.first; c < T.first + T.count; c++) {
      const np = D.npts[c], s0 = D.starts[c];
      const cl = D.cls[c], fl = D.flags[c], surf = D.surface[c];
      const hw = D.width[c] / 8, bridge = fl & BRIDGE, town = fl & TOWN;
      const lanes = surf === ASPHALT && cl <= 4 ? D.lanes[c] : 0;
      const P = [];
      for (let i = 0; i < np; i++) P.push([D.cx + D.xy[(s0 + i) * 2] / 2, D.cy + D.xy[(s0 + i) * 2 + 1] / 2]);
      // along distance, miter normals
      const S = [0], N = [];
      for (let i = 1; i < np; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
      for (let i = 0; i < np; i++) {
        const a = P[Math.max(i - 1, 0)], b = P[i], d = P[Math.min(i + 1, np - 1)];
        const d1 = norm2(b[0] - a[0] || d[0] - b[0], b[1] - a[1] || d[1] - b[1]);
        const d2 = norm2(d[0] - b[0] || b[0] - a[0], d[1] - b[1] || b[1] - a[1]);
        const n1 = [-d1[1], d1[0]], n2 = [-d2[1], d2[0]];
        const m = norm2(n1[0] + n2[0], n1[1] + n2[1]);
        const sc = 1 / Math.max(m[0] * n1[0] + m[1] * n1[1], 0.45);
        N.push([m[0] * sc, m[1] * sc]);
      }
      const ground = P.map(([x, y]) => this.terrain.heightAt(x, y) * ex);
      const L = S[np - 1] || 1;
      let top;
      if (bridge) {                                  // arched deck between the two banks
        const g0 = ground[0], g1 = ground[np - 1];
        const clear = L > 150 ? Math.min(L * 0.05, 25) : Math.min(Math.max(L * 0.09, 1.2), 9);
        top = S.map((s) => {
          const t = s / L, base = g0 + (g1 - g0) * t + 0.6;
          const prof = L > 150 ? smooth(0, 0.3, t) * smooth(1, 0.7, t) : Math.pow(Math.sin(Math.PI * t), 0.8);
          return base + clear * 1.5 * prof;
        });
      }
      const e = bridge ? 0 : embankment(cl, fl);
      const street = town && !bridge;
      const sh = bridge ? 0.25 : street ? (cl <= 3 ? 3.5 : cl <= 5 ? 2.6 : cl <= 6 ? 1.3 : 0.3) : cl <= 4 ? 1.0 : 0.4;
      const run = bridge ? 0 : Math.max(e * 1.7, 0.3);
      const offs = [-(hw + sh + run), -(hw + sh), -hw, hw, hw + sh, hw + sh + run];
      const rise = [0, e, e, e, e, 0];
      const parts = [PART.slope, town ? PART.walk : PART.shoulder, PART.road, town ? PART.walk : PART.shoulder, PART.slope];
      let prev = null;
      for (let i = 0; i < np; i++) {
        const [x, y] = P[i], [nx, ny] = N[i];
        const yTop = bridge ? top[i] : ground[i];
        const row = [];
        for (let k = 0; k < 5; k++) {                // 5 strips, own vertices each so every part keeps its colour
          if (bridge && (k === 0 || k === 4)) continue;
          for (const j of [k, k + 1]) {
            // town: street just above the ground, sidewalks a kerb higher, outer edge back down to the ground
            const yy = bridge ? yTop : !street ? yTop + rise[j] : k === 2 ? yTop + 0.06 : (j === 0 || j === 5) ? yTop : yTop + 0.06 + KERB;
            row.push(vert(x + nx * offs[j], yy, y + ny * offs[j], S[i], offs[j], hw, surf, lanes, parts[k]));
          }
        }
        if (prev) for (let k = 0; k < row.length; k += 2) strip([prev[k], prev[k + 1]], [row[k], row[k + 1]]);
        prev = row;
      }
      if (street) {
        // kerb faces between the street and the sidewalks
        for (const sd of [-1, 1]) {
          let pr = null;
          for (let i = 0; i < np; i++) {
            const [x, y] = P[i], [nx, ny] = N[i], o = sd * hw;
            const r = [vert(x + nx * o, ground[i] + 0.06, y + ny * o, S[i], o, hw, surf, 0, PART.kerb),
                       vert(x + nx * o, ground[i] + 0.06 + KERB, y + ny * o, S[i], o, hw, surf, 0, PART.kerb)];
            if (pr) strip(pr, r);
            pr = r;
          }
        }
        townRoads.push({ P, S, N, hw, sh, cl, y: ground.map((g) => g + 0.06 + KERB) });
      }
      // country roads: power lines run along most of them (on the shoulder)
      if (!town && !bridge && cl >= 3 && cl <= 6) townRoads.push({ P, S, N, hw, sh, cl, rural: true, y: ground.map((g) => g + e) });
      if (bridge) {
        // railings both sides, pier walls every ~15 m
        for (const sd of [-1, 1]) {
          let pr = null;
          for (let i = 0; i < np; i++) {
            const [x, y] = P[i], [nx, ny] = N[i], o = sd * (hw + sh), h = surf === WOOD ? 0.9 : 1.0;
            const r = [vert(x + nx * o, top[i], y + ny * o, S[i], o, hw, surf, 0, PART.rail),
                       vert(x + nx * o, top[i] + h, y + ny * o, S[i], o, hw, surf, 0, PART.rail)];
            if (pr) strip(pr, r);
            pr = r;
          }
        }
        // piers: a pair of columns (two crossed panels each); none under short single-span bridges
        const spacing = L > 150 ? 40 : 15, nPier = L < 25 ? 0 : Math.floor(L / spacing);
        const bottom = Math.min(...ground) - 3, cw = surf === WOOD ? 0.15 : L > 150 ? 0.9 : 0.4;
        for (let k = 1; k <= nPier; k++) {
          const s = (k * L) / (nPier + 1);
          let i = 1;
          while (i < np - 1 && S[i] < s) i++;
          const [x, y] = P[i], [nx, ny] = N[i];
          const tx = -ny, ty = nx;                               // along the deck
          for (const sd of [-0.6, 0.6]) {
            const px = x + nx * hw * sd, py = y + ny * hw * sd;
            for (const [ax, ay] of [[nx, ny], [tx, ty]]) {
              const a = vert(px - ax * cw, top[i] - 0.3, py - ay * cw, s, 0, hw, surf, 0, PART.pier);
              const b = vert(px + ax * cw, top[i] - 0.3, py + ay * cw, s, 0, hw, surf, 0, PART.pier);
              const cc = vert(px + ax * cw, bottom, py + ay * cw, s, 0, hw, surf, 0, PART.pier);
              const d = vert(px - ax * cw, bottom, py - ay * cw, s, 0, hw, surf, 0, PART.pier);
              idx.push(a, b, cc, a, cc, d);
            }
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.material);
    m.raycast = () => {};
    if (this.streets && townRoads.length) {
      T.furn = this.streets.build(townRoads, new THREE.Sphere(new THREE.Vector3(T.cx, T.ground, T.cz), this.tileM * 0.75 + 200));
      if (T.furn) this.streets.group.add(T.furn);
    }
    return m;
  }

  update(camera) {
    if (!this.group.visible) return;
    const p = camera.position, half = this.tileM / 2;
    let built = 0;
    for (const T of this.tiles) {
      const dx = Math.max(Math.abs(p.x - T.cx) - half, 0), dz = Math.max(Math.abs(p.z - T.cz) - half, 0);
      const d = Math.hypot(dx, dz, Math.max(p.y - T.ground - 30, 0));
      if (d < this.farR + 200) {
        if (!T.mesh && built < 2) { T.mesh = this.build(T); this.group.add(T.mesh); built++; }   // spread the work
      } else if (T.mesh && d > this.farR + 1500) {
        this.group.remove(T.mesh);
        T.mesh.geometry.dispose();
        T.mesh = null;
        if (T.furn) { this.streets.dispose(T.furn); T.furn = null; }
      }
      if (T.furn) T.furn.visible = d < 1400;
    }
  }
}

const norm2 = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
const smooth = (a, b, t) => { const u = Math.min(Math.max((t - a) / (b - a), 0), 1); return u * u * (3 - 2 * u); };
