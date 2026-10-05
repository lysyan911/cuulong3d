// Grass and reeds near the camera (Claude Code, rendering): tufts of thin blades on green ground within ~110 m, and
// taller reeds (cỏ lác, sậy) along canal and river banks. Placed per 24 m cell (hashed, so a place always looks the
// same) where the ground really is green: not on water, rice, paving, roads or the Trà Sư wetland, and denser where
// the satellite image is greener. Each tuft takes its colour from the ground under it, the blades sway in the wind,
// and they shrink away at the edge of the range (no popping). Blade normals point up, so grass is lit like the
// ground it grows on. Built a few cells per frame.
import * as THREE from 'three';
import { GLOBALS } from './render/globals.js';
import { patchCloudShadow, cloudUniforms } from './render/atmosphere.js';
import { groupCentre } from './world.js';
import { hash12 } from './surface.js';

const CELL = 24, PER_CELL = 300, BUILD_PER_FRAME = 3;
// value noise for grass patches (thick in places, trodden bare in others)
const vn = (x, y) => {
  const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, a = u * u * (3 - 2 * u), b = v * v * (3 - 2 * v);
  return (hash12(i, j) * (1 - a) + hash12(i + 1, j) * a) * (1 - b) + (hash12(i, j + 1) * (1 - a) + hash12(i + 1, j + 1) * a) * b;
};
const patchAt = (x, y) => vn(x / 9, y / 9) * 0.65 + vn(x / 3.1 + 17, y / 3.1) * 0.35;
const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

// a clump of broad leaves (seen from 25 m and more, single blades would be thinner than a pixel)
function tuftGeometry(blades = 11) {
  const pos = [], col = [], nor = [], idx = [];
  for (let b = 0; b < blades; b++) {
    const a = b * 2.4 + 0.3, r = 0.05 + 0.3 * ((b * 0.37) % 1), h = 0.45 + 0.55 * ((b * 0.61) % 1);
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r, w = 0.075, px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    const lean = 0.35 + 0.3 * ((b * 0.83) % 1);                 // tips lean outwards
    const base = pos.length / 3;
    pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, bx + Math.cos(a) * lean * h, h, bz + Math.sin(a) * lean * h);
    col.push(0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 1.2, 1.25, 1.0);  // dark at the root (self-shadowing), light at the tip
    for (let k = 0; k < 3; k++) nor.push(0, 1, 0);
    idx.push(base, base + 1, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

export class GrassLayer {
  constructor(meta, terrain, textures, { roads3d = null, mobile = false, time } = {}) {
    this.meta = meta; this.terrain = terrain; this.surface = terrain.surface; this.textures = textures;
    this.roads3d = roads3d; this.ex = meta.vert_exag;
    this.R = mobile ? 60 : 110;
    this.cap = mobile ? 3000 : 16000;
    this.cells = new Map(); this.images = new Map(); this.bboxes = new WeakMap();
    this.group = new THREE.Group(); this.group.name = 'grass';
    const geo = tuftGeometry();
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 4), 4);   // rgb, phase
    this.tint.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTint', this.tint);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.92 });
    const uniforms = { uTime: time, uViewPos: GLOBALS.uViewPos, uR: { value: this.R } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aTint; uniform float uTime, uR; uniform vec3 uViewPos;')
        .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb *= aTint.rgb;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 gw = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float gd = distance(gw, uViewPos);
          // fewer tufts further out, shrinking away at the edge of the range
          float keep = step(aTint.w, 1.0 - 0.55 * smoothstep(uR * 0.45, uR * 0.75, gd));
          transformed *= keep * (1.0 - smoothstep(uR * 0.8, uR, gd));
          float k = position.y * position.y;
          float sw = sin(uTime * 1.7 + gw.x * 0.21 + gw.z * 0.13 + aTint.w * 6.0) * 0.6 + sin(uTime * 3.1 + gw.x * 0.5) * 0.25;
          transformed.x += sw * 0.09 * k; transformed.z += sw * 0.05 * k;`);
      patchCloudShadow(sh, cloudUniforms());
    };
    mat.customProgramCacheKey = () => 'cuulong-grass-1';
    this.mesh = new THREE.InstancedMesh(geo, mat, this.cap);
    this.mesh.count = 0; this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    Object.assign(this.mesh.userData, { receiveOnly: true, noReflect: true });
    this.group.add(this.mesh);
    this.key = '';
  }

  // a group's satellite / land-use image on a canvas; pixels are read in 64 px blocks as needed (reading a whole
  // 1344 px image back took ~11 ms, a hitch whenever the camera entered a new group)
  image(kind, gx, gy) {
    const k = `${kind}${gx}_${gy}`;
    if (this.images.has(k)) return this.images.get(k);
    const img = this.textures[kind]?.[gy]?.[gx]?.image;
    let im = null;
    if (img && img.width) {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      im = { w: img.width, h: img.height, g, blocks: new Map() };
    }
    if (this.images.size > 8) this.images.delete(this.images.keys().next().value);
    this.images.set(k, im);
    return im;
  }

  pixel(kind, x, y) {
    const m = this.meta, span = m.group * m.grid_res_m;
    const gx = Math.floor((x + m.width_m / 2 - m.grid_res_m / 2) / span), gy = Math.floor((m.height_m / 2 - m.grid_res_m / 2 - y) / span);
    if (gx < 0 || gy < 0 || gx >= m.groups[0] || gy >= m.groups[1]) return null;
    const im = this.image(kind, gx, gy);
    if (!im) return null;
    const [cx, cy] = groupCentre(m, gx, gy);
    const u = (x - cx) / span + 0.5, v = (cy - y) / span + 0.5;
    const px = Math.min(im.w - 1, Math.max(0, Math.floor(u * im.w))), py = Math.min(im.h - 1, Math.max(0, Math.floor(v * im.h)));
    const bk = (py >> 6) * 1000 + (px >> 6);
    let b = im.blocks.get(bk);
    if (!b) {
      const bx = (px >> 6) << 6, by = (py >> 6) << 6;
      b = im.g.getImageData(bx, by, Math.min(64, im.w - bx), Math.min(64, im.h - by));
      if (im.blocks.size > 64) im.blocks.delete(im.blocks.keys().next().value);
      im.blocks.set(bk, b);
    }
    const i = ((py & 63) * b.width + (px & 63)) * 4;
    return b.data.subarray(i, i + 4);
  }

  // road segments near a cell, with their clearance (half width + kerb / shoulder + a little)
  roadsNear(x0, y0, x1, y1) {
    const out = [];
    if (!this.roads3d) return out;
    for (const T of this.roads3d.tiles) {
      if (Math.abs(T.cx - (x0 + x1) / 2) > 2000 || Math.abs(-T.cz - (y0 + y1) / 2) > 2000) continue;
      const D = T.data;
      let bb = this.bboxes.get(D);
      if (!bb) {
        bb = new Float32Array(D.npts.length * 4);
        for (let c = 0; c < D.npts.length; c++) {
          let a = 1e9, b = 1e9, e = -1e9, f = -1e9;
          for (let i = 0; i < D.npts[c]; i++) {
            const x = D.cx + D.xy[(D.starts[c] + i) * 2] / 2, y = D.cy + D.xy[(D.starts[c] + i) * 2 + 1] / 2;
            a = Math.min(a, x); b = Math.min(b, y); e = Math.max(e, x); f = Math.max(f, y);
          }
          bb.set([a, b, e, f], c * 4);
        }
        this.bboxes.set(D, bb);
      }
      for (let c = T.first; c < T.first + T.count; c++) {
        const clear = D.width[c] / 8 + Math.max(D.sidewalk[c] / 10, D.flags[c] & 2 ? 2.6 : 0.8) + 0.4;
        if (bb[c * 4] > x1 + clear || bb[c * 4 + 2] < x0 - clear || bb[c * 4 + 1] > y1 + clear || bb[c * 4 + 3] < y0 - clear) continue;
        for (let i = 0; i < D.npts[c] - 1; i++) {
          const s = (D.starts[c] + i) * 2;
          out.push(D.cx + D.xy[s] / 2, D.cy + D.xy[s + 1] / 2, D.cx + D.xy[s + 2] / 2, D.cy + D.xy[s + 3] / 2, clear);
        }
      }
    }
    return out;
  }

  build(ci, cj) {
    const x0 = ci * CELL, y0 = cj * CELL, S = this.surface, W = this.terrain.wetland;
    const roads = this.roadsNear(x0, y0, x0 + CELL, y0 + CELL);
    const mats = [], tints = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    for (let i = 0; i < PER_CELL; i++) {
      const r1 = hash12(ci * 7 + i * 13, cj * 11 - i * 5), r2 = hash12(cj * 3 + i * 17, ci * 5 + i * 3), r3 = hash12(i * 29 + ci, i * 31 + cj);
      const x = x0 + r1 * CELL, y = y0 + r2 * CELL;
      const water = S ? S.waterAt(x, y) : 0, shore = S ? S.shoreAt(x, y) : 999;
      const reed = shore >= 1.5 && shore < 9 && water < 0.5;                     // reed band along the banks
      if (!reed && (water > 0.05 || (shore >= 0 && shore < 1.5))) continue;
      if (S && S.cropAt(x, y) > 0.5) continue;
      if (W && W.floodAt(x, y) > 0.2) continue;
      const lu = this.pixel('crop', x, y), sat = this.pixel('sat', x, y);
      if (lu && lu[1] > 90) continue;                                            // paved
      const a = lu ? lu[3] : 160;
      // greenness of the satellite pixel: dense on green ground, sparse dry grass on bare or brown ground
      // tint: the ground colour (linear), pulled towards fresh grass green on green ground
      let green = 0.5, tr = 0.09, tg = 0.14, tb = 0.03;
      if (sat) {
        const R = sat[0] / 255, G = sat[1] / 255, B = sat[2] / 255;
        green = Math.min(1, Math.max(0, (G - Math.max(R, B) * 0.95) * 14 + 0.25));
        tr = R ** 2.2; tg = G ** 2.2; tb = B ** 2.2;
        const k = 0.5 * green;
        tr = tr * (1 - k) + 0.06 * k; tg = tg * (1 - k) + 0.13 * k; tb = tb * (1 - k) + 0.02 * k;
        tr *= 1.55; tg *= 1.7; tb *= 1.3;
      }
      let density = smooth(0.3, 0.75, green);                                    // grass only where the ground is green
      if (a > 240) density = 1;                                                  // lawn
      else if (a < 100) density = 0;                                             // bare earth, building sites
      if (reed) density = 0.9;
      else density *= 0.04 + 0.96 * smooth(0.42, 0.72, patchAt(x, y));         // in patches, a few strays between
      if (r3 > density) continue;
      let blocked = false;
      for (let k = 0; k < roads.length; k += 5) {
        const ax = roads[k], ay = roads[k + 1], bx = roads[k + 2], by = roads[k + 3], dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(x - ax - dx * t, y - ay - dy * t) < roads[k + 4]) { blocked = true; break; }
      }
      if (blocked) continue;
      const h = this.terrain.heightAt(x, y) * this.ex;
      const size = reed ? 1.6 + r3 * 1.4 : 0.35 + 0.5 * r1 * (0.6 + 0.4 * green);
      p.set(x, h - 0.03, -y); q.setFromAxisAngle(up, r2 * 6.283); s.set(size * (reed ? 0.7 : 1.1), size, size * (reed ? 0.7 : 1.1));
      m.compose(p, q, s); mats.push(...m.elements);
      const dry = 1 - green, v = 0.85 + 0.3 * r2;
      tints.push((tr + dry * 0.025) * v * (reed ? 0.85 : 1), (tg + dry * 0.012) * v * (reed ? 1.1 : 1), tb * v, (r1 + r2 * 7.1) % 1);
    }
    return { mats: new Float32Array(mats), tints: new Float32Array(tints), n: tints.length / 4 };
  }

  update(camera) {
    if (!this.group.visible || !this.surface) return;
    const cp = camera.position, ground = this.terrain.heightAt(cp.x, -cp.z) * this.ex;
    if (cp.y - ground > this.R * 1.6) { this.mesh.count = 0; this.key = ''; return; }
    const R = this.R, i0 = Math.floor((cp.x - R) / CELL), i1 = Math.floor((cp.x + R) / CELL);
    const j0 = Math.floor((-cp.z - R) / CELL), j1 = Math.floor((-cp.z + R) / CELL);
    const want = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const dx = Math.max(Math.abs((i + 0.5) * CELL - cp.x) - CELL / 2, 0), dy = Math.max(Math.abs((j + 0.5) * CELL + cp.z) - CELL / 2, 0);
      if (dx * dx + dy * dy < R * R) want.push([i, j, dx * dx + dy * dy]);
    }
    want.sort((a, b) => a[2] - b[2]);
    let built = 0, missing = false;
    for (const [i, j] of want) {
      const k = i + '_' + j;
      if (this.cells.has(k)) continue;
      if (built >= BUILD_PER_FRAME) { missing = true; continue; }
      this.cells.set(k, this.build(i, j)); built++;
    }
    const key = `${i0}_${i1}_${j0}_${j1}_${this.cells.size}`;
    if (key === this.key && !built) return;
    this.key = missing ? '' : key;
    // pack the wanted cells, nearest first, into the instance buffers
    let n = 0;
    const M = this.mesh.instanceMatrix.array, T = this.tint.array;
    for (const [i, j] of want) {
      const c = this.cells.get(i + '_' + j);
      if (!c || n + c.n > this.cap) continue;
      M.set(c.mats, n * 16); T.set(c.tints, n * 4); n += c.n;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true; this.tint.needsUpdate = true;
    // forget cells well out of range
    if (this.cells.size > want.length * 2) {
      for (const k of this.cells.keys()) {
        const [i, j] = k.split('_').map(Number);
        if (Math.hypot((i + 0.5) * CELL - cp.x, (j + 0.5) * CELL + cp.z) > R * 2) this.cells.delete(k);
      }
    }
  }
}
