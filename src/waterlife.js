// Life on the rivers and canals near the camera (Claude Code, rendering):
//  - boat wakes: churned water behind each moving boat and the two arms of its V-shaped (Kelvin, ~19.5°) wake, fading
//    along their length; foam is the beige-white of the silty Mekong, not sea-white. Boats come from props.js.
//  - lục bình (water hyacinth): rafts of floating rosettes, glossy leaves on swollen stalks, a few lilac flower
//    spikes, gently bobbing; more along the banks of canals and rivers, odd rafts drifting mid-river. Not in Trà Sư
//    (it has its own duckweed). Placed per 48 m cell (hashed, stable), built a few cells per frame.
import * as THREE from 'three';
import { GLOBALS } from './render/globals.js';
import { patchCloudShadow, cloudUniforms } from './render/atmosphere.js';
import { hash12 } from './surface.js';

const CELL = 48, BUILD_PER_FRAME = 2, KELVIN = Math.tan(19.5 * Math.PI / 180);

// one hyacinth rosette (~0.7 m across): rounded leaves on swollen stalks, tilted up and out
function rosette() {
  const pos = [], col = [], idx = [];
  const leaf = (a, tilt, len, r) => {
    const ca = Math.cos(a), sa = Math.sin(a), b = pos.length / 3;
    const stalk = [ca * len * 0.45, Math.sin(tilt) * len * 0.45 + 0.05, sa * len * 0.45];
    const cx = ca * len * 0.75, cy = Math.sin(tilt) * len * 0.8 + 0.08, cz = sa * len * 0.75;
    pos.push(0, 0.02, 0, ...stalk);
    col.push(0.6, 0.75, 0.45, 0.85, 1.0, 0.7);
    for (let k = 0; k < 5; k++) {                                         // round blade around (cx, cy, cz)
      const t = (k / 5) * Math.PI * 2, px = -sa * Math.cos(t) * r + ca * Math.sin(t) * r * 0.6;
      const pz = ca * Math.cos(t) * r + sa * Math.sin(t) * r * 0.6, py = Math.sin(t) * r * 0.55 * Math.cos(tilt);
      pos.push(cx + px, cy + py, cz + pz); col.push(1, 1, 1);
    }
    for (let k = 0; k < 5; k++) idx.push(b + 1, b + 2 + k, b + 2 + (k + 1) % 5);
    idx.push(b, b + 1, b + 2);
  };
  for (let i = 0; i < 7; i++) leaf(i * 2.4, 0.5 + 0.35 * ((i * 0.37) % 1), 0.3 + 0.12 * ((i * 0.61) % 1), 0.1 + 0.03 * ((i * 0.53) % 1));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function flowerSpike() {
  const g = new THREE.ConeGeometry(0.05, 0.22, 5, 1); g.translate(0, 0.3, 0);
  const s = new THREE.CylinderGeometry(0.008, 0.01, 0.2, 4); s.translate(0, 0.12, 0);
  const m = new THREE.BufferGeometry();
  const merge = [g, s].map((x) => x.toNonIndexed());
  const pos = [...merge[0].attributes.position.array, ...merge[1].attributes.position.array];
  const col = [...Array(merge[0].attributes.position.count).fill([0.62, 0.48, 0.85]).flat(), ...Array(merge[1].attributes.position.count).fill([0.3, 0.5, 0.2]).flat()];
  m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  m.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  m.computeVertexNormals();
  return m;
}

export class WaterLife {
  constructor(meta, terrain, props, { mobile = false, time } = {}) {
    this.meta = meta; this.terrain = terrain; this.surface = terrain.surface; this.props = props;
    this.R = mobile ? 140 : 260; this.cap = mobile ? 800 : 3000;
    this.cells = new Map(); this.key = '';
    this.group = new THREE.Group(); this.group.name = 'waterlife';
    const sway = { uTime: time };
    const bob = (sh) => {
      Object.assign(sh.uniforms, sway);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 lw = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float ph = lw.x * 0.37 + lw.z * 0.23;
          transformed.y += sin(uTime * 0.9 + ph) * 0.025;                      // gentle bob on the ripples
          transformed.xz += vec2(sin(uTime * 0.5 + ph), cos(uTime * 0.4 + ph * 1.3)) * 0.04 * transformed.y;`);
      patchCloudShadow(sh, cloudUniforms());
    };
    const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x2f6a1c, roughness: 0.45, side: THREE.DoubleSide });
    leafMat.onBeforeCompile = bob; leafMat.customProgramCacheKey = () => 'cuulong-hyacinth-1';
    const flowerMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    flowerMat.onBeforeCompile = bob; flowerMat.customProgramCacheKey = () => 'cuulong-hyacinth-flower-1';
    this.leaves = new THREE.InstancedMesh(rosette(), leafMat, this.cap);
    this.flowers = new THREE.InstancedMesh(flowerSpike(), flowerMat, Math.ceil(this.cap / 5));
    for (const m of [this.leaves, this.flowers]) {
      m.count = 0; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      Object.assign(m.userData, { receiveOnly: true, noReflect: true });
      this.group.add(m);
    }
    // wakes: a unit plane, x -1..1 across, z 0..-1 behind the stern; per instance (length, half width, beam, fade)
    const wg = new THREE.PlaneGeometry(2, 1, 1, 1); wg.rotateX(-Math.PI / 2); wg.translate(0, 0, -0.5);
    this.wakeInfo = new THREE.InstancedBufferAttribute(new Float32Array(64 * 4), 4); this.wakeInfo.setUsage(THREE.DynamicDrawUsage);
    wg.setAttribute('aWake', this.wakeInfo);
    const wm = new THREE.MeshBasicMaterial({ color: 0xd8cdb8, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    wm.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uTime: time });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aWake; varying vec4 vWake; varying vec2 vWuv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWake = aWake; vWuv = vec2(position.x, -position.z);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uTime; varying vec4 vWake; varying vec2 vWuv;
          float wkH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float wkN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(wkH(i), wkH(i + vec2(1, 0)), f.x), mix(wkH(i + vec2(0, 1)), wkH(i + 1.0), f.x), f.y); }`)
        .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
          float along = vWuv.y * vWake.x, across = abs(vWuv.x) * vWake.y, beam = vWake.z;
          float fadeL = 1.0 - smoothstep(0.0, vWake.x, along);
          // churned stern wash, widening slowly
          float wash = exp(-pow(across / (beam * 0.45 + along * 0.06), 2.0)) * exp(-along / (vWake.x * 0.25));
          // the two V arms, broken into streaks
          float arm = beam * 0.5 + along * ${KELVIN.toFixed(4)};
          float arms = exp(-pow((across - arm) / (0.45 + along * 0.02), 2.0)) * fadeL * fadeL;
          // feathered crests along the arms (wavelength grows with the boat's speed, carried in vWake.w)
          float lam = 0.8 + 4.0 * vWake.w;
          float crest = 0.7 + 0.3 * sin((along + across * 0.6) / lam * 6.2832);
          vec2 q = vec2(across * 1.7, along * 0.8 - uTime * 0.9);
          float br = 0.35 + 0.65 * wkN(q) * wkN(q * 2.7 + 7.0);
          float foam = clamp(wash * 0.55 * br + arms * 0.32 * crest * (0.35 + 0.65 * br), 0.0, 1.0);
          diffuseColor.a *= foam * (0.35 + 0.65 * vWake.w);
          if (diffuseColor.a < 0.01) discard;`);
    };
    wm.customProgramCacheKey = () => 'cuulong-wake-1';
    this.wakes = new THREE.InstancedMesh(wg, wm, 64);
    this.wakes.count = 0; this.wakes.frustumCulled = false; this.wakes.renderOrder = 2;
    Object.assign(this.wakes.userData, { noShadow: true, noReflect: true });
    this.group.add(this.wakes);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  build(ci, cj) {
    const S = this.surface, W = this.terrain.wetland, x0 = ci * CELL, y0 = cj * CELL, out = [];
    for (let r = 0; r < 4; r++) {                                        // up to four tries for a raft in this cell
      const h1 = hash12(ci * 13 + r, cj * 5), h2 = hash12(cj * 11 - r, ci * 3), h3 = hash12(ci + r * 7, cj + r * 3);
      const rx = x0 + h1 * CELL, ry = y0 + h2 * CELL;
      if (S.waterAt(rx, ry) < 0.8 || (W && W.floodAt(rx, ry) > 0.1)) continue;
      const nearBank = S.shoreAt(rx, ry) > -25;                         // negative: metres into the water
      if (hash12(ci * 3 + r, cj * 7 - r) > (nearBank ? 0.4 : 0.05)) continue;   // rafts mostly along the banks
      const len = 3 + h3 * (nearBank ? 14 : 8), wid = 1.5 + h3 * 4, ang = h1 * 6.283;
      const n = Math.round(len * wid * 2.2);                               // dense mats, rosettes touching
      for (let i = 0; i < n; i++) {
        const a = hash12(i * 17 + ci, r * 31 + cj), b = hash12(i * 29 + cj, r * 13 + ci), u = (a - 0.5) * len, v = (b - 0.5) * wid * (1 - 1.6 * (a - 0.5) ** 2);
        const x = rx + u * Math.cos(ang) - v * Math.sin(ang), y = ry + u * Math.sin(ang) + v * Math.cos(ang);
        if (S.waterAt(x, y) < 0.8) continue;
        out.push(x, y, a * 6.283, 0.85 + b * 0.6, hash12(i, ci + cj) < 0.14 ? 1 : 0);
      }
    }
    return out;
  }

  update(camera) {
    if (!this.group.visible || !this.surface) return;
    const cp = camera.position, T = this.terrain;
    this.updateWakes(cp);
    const ground = T.heightAt(cp.x, -cp.z) * this.meta.vert_exag;
    if (cp.y - ground > this.R * 1.5) { this.leaves.count = this.flowers.count = 0; this.key = ''; return; }
    const R = this.R, i0 = Math.floor((cp.x - R) / CELL), i1 = Math.floor((cp.x + R) / CELL);
    const j0 = Math.floor((-cp.z - R) / CELL), j1 = Math.floor((-cp.z + R) / CELL);
    const want = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const d = Math.hypot((i + 0.5) * CELL - cp.x, (j + 0.5) * CELL + cp.z);
      if (d < R + CELL) want.push([i, j, d]);
    }
    want.sort((a, b) => a[2] - b[2]);
    let built = 0;
    for (const [i, j] of want) {
      const k = i + '_' + j;
      if (this.cells.has(k)) continue;
      if (built++ >= BUILD_PER_FRAME) break;
      this.cells.set(k, this.build(i, j));
    }
    const key = `${i0}_${i1}_${j0}_${j1}_${this.cells.size}`;
    if (key === this.key) return;
    this.key = key;
    let n = 0, f = 0;
    const m = this._m, q = this._q, p = this._p, s = this._s;
    for (const [i, j] of want) {
      const c = this.cells.get(i + '_' + j);
      if (!c) continue;
      for (let k = 0; k < c.length && n < this.cap; k += 5) {
        const x = c[k], y = c[k + 1], h = T.waterHeightAt(x, y) + 0.02;
        q.setFromAxisAngle(this._up, c[k + 2]); p.set(x, h, -y); s.setScalar(c[k + 3]);
        m.compose(p, q, s); this.leaves.setMatrixAt(n++, m);
        if (c[k + 4] && f < this.flowers.instanceMatrix.count) this.flowers.setMatrixAt(f++, m);
      }
    }
    this.leaves.count = n; this.flowers.count = f;
    this.leaves.instanceMatrix.needsUpdate = this.flowers.instanceMatrix.needsUpdate = true;
    if (this.cells.size > want.length * 2) {
      for (const k of this.cells.keys()) {
        const [i, j] = k.split('_').map(Number);
        if (Math.hypot((i + 0.5) * CELL - cp.x, (j + 0.5) * CELL + cp.z) > R * 2) this.cells.delete(k);
      }
    }
  }

  updateWakes(cp) {
    const list = this.props?.wakes || [];
    let n = 0;
    for (const w of list) {
      if (n >= 64) break;
      const sp = Math.min(w.v / 3, 1.2), Lw = 12 + w.L * 4 * sp, hw = w.B * 0.5 + Lw * KELVIN + 2;
      if (Math.hypot(w.x - cp.x, w.z - cp.z) > 1500) continue;
      const len = Math.hypot(w.fx, w.fz) || 1, fx = w.fx / len, fz = w.fz / len;
      this._q.setFromAxisAngle(this._up, Math.atan2(fx, fz));
      this._p.set(w.x - fx * w.L * 0.45, w.y + 0.05, w.z - fz * w.L * 0.45);
      this._s.set(hw, 1, Lw);
      this._m.compose(this._p, this._q, this._s);
      this.wakes.setMatrixAt(n, this._m);
      this.wakeInfo.setXYZW(n, Lw, hw, w.B, w.fade * Math.min(sp, 1));
      n++;
    }
    this.wakes.count = n;
    if (n) { this.wakes.instanceMatrix.needsUpdate = true; this.wakeInfo.needsUpdate = true; }
  }
}
