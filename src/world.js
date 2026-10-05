// Roads and landmarks (buildings: houses.js, trees: trees.js).
// Everything is stored per 26.9 km group; whole groups are hidden beyond a distance.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { landmarkModels } from './models.js';
import { cloudUniforms, patchCloudShadow } from './render/atmosphere.js';

export function groupCentre(meta, gx, gy) {
  const span = meta.group * meta.grid_res_m;
  const x0 = -meta.width_m / 2 + (gx * meta.group + 0.5) * meta.grid_res_m;
  const y0 = meta.height_m / 2 - (gy * meta.group + 0.5) * meta.grid_res_m;
  return [x0 + span / 2, y0 - span / 2];
}

/** Base for per-group layers: distance culling by the camera's distance to each group's square. */
export class GroupLayer {
  constructor(name, meta) {
    this.meta = meta;
    this.group = new THREE.Group();
    this.group.name = name;
    this.cells = [];
  }
  /** centre: optional [x, north] and half size of a smaller cell (default: the group's square). */
  addCell(gx, gy, obj, maxDistance, centre = null, half = null) {
    const [cx, cy] = centre || groupCentre(this.meta, gx, gy);
    this.cells.push({ obj, centre: new THREE.Vector3(cx, 0, -cy), maxDistance, half });
    this.group.add(obj);
  }
  update(camera) {
    const gHalf = (this.meta.group * this.meta.grid_res_m) / 2, p = camera.position;
    const inner = this.ribbon ? this.ribbon.value * 0.7 : 0;
    for (const c of this.cells) {
      const half = c.half || gHalf, ax = Math.abs(p.x - c.centre.x), az = Math.abs(p.z - c.centre.z);
      const dx = Math.max(ax - half, 0), dz = Math.max(az - half, 0);
      c.obj.visible = Math.hypot(dx, dz, p.y) < c.maxDistance;
      // a cell entirely inside the 3D road zone: its lines are faded out there anyway, don't draw them
      if (inner && p.y < inner && Math.hypot(ax + half, az + half) < inner) c.obj.visible = false;
    }
  }
}

// (trees: see trees.js)
// (real buildings: see houses.js)

// ---------------------------------------------------------------- roads (screen-width lines, hybrid-map style)
// File: int32 counts[nClasses] | per class: int16 [ax, ay, ah, bx, by, bh] (m, m, dm) rel. group centre
export const ROAD_STYLE = {
  motorway: { color: 0xf6bd45, width: 4.0, opacity: 1, maxDist: 400000 },
  trunk: { color: 0xf8d065, width: 3.4, opacity: 1, maxDist: 400000 },
  primary: { color: 0xfbe08a, width: 3.0, opacity: 1, maxDist: 300000 },
  secondary: { color: 0xfff0b4, width: 2.5, opacity: 0.95, maxDist: 160000 },
  tertiary: { color: 0xffffff, width: 2.0, opacity: 0.9, maxDist: 70000 },
  residential: { color: 0xffffff, width: 1.4, opacity: 0.8, maxDist: 22000 },
  service: { color: 0xf2f2f2, width: 1.1, opacity: 0.65, maxDist: 9000 },
  track: { color: 0xecd6a8, width: 1.3, opacity: 0.8, maxDist: 9000, dashed: true },
  path: { color: 0xf6e9c8, width: 1.1, opacity: 0.8, maxDist: 7000, dashed: true },
};

export class RoadLayer extends GroupLayer {
  /** ribbonR: within this distance the 3D road ribbons (roads3d.js) take over and the lines fade out. */
  constructor(meta, distScale = 1, ribbonR = 0) {
    super('roads', meta);
    this.classes = meta.road_classes;
    this.distScale = distScale;
    this.ribbon = { value: ribbonR };
    this.materials = this.classes.map((c) => {
      const st = ROAD_STYLE[c];
      const m = new LineMaterial({ color: st.color, linewidth: st.width, transparent: true, opacity: st.opacity,
                                   dashed: !!st.dashed, dashSize: 8, gapSize: 6, depthWrite: false });
      m.resolution.set(innerWidth, innerHeight);
      m.fog = true;                          // lines fade into the aerial haze like everything else
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uRibbonR = this.ribbon;
        sh.vertexShader = sh.vertexShader.replace('void main() {', `uniform float uRibbonR;
          varying float vRibbonFade;
          void main() {
            vRibbonFade = uRibbonR > 0.0 ? smoothstep(uRibbonR * 0.75, uRibbonR, distance(cameraPosition, instanceStart)) : 1.0;`);
        sh.fragmentShader = sh.fragmentShader
          .replace('void main() {', `varying float vRibbonFade;
          void main() {`)
          .replace('#include <fog_fragment>', `#include <fog_fragment>
            gl_FragColor.a *= vRibbonFade;
            #ifdef USE_FOG
              gl_FragColor.a *= 1.0 - fogFactor;
            #endif
            if (gl_FragColor.a < 0.01) discard;`);
      };
      m.customProgramCacheKey = () => 'cuulong-roadline-haze-' + (st.dashed ? 'd' : 's');
      return m;
    });
  }

  setResolution(w, h) { for (const m of this.materials) m.resolution.set(w, h); }

  async loadCell(gx, gy, url) {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    const nc = this.classes.length;
    const counts = new Int32Array(buf, 0, nc);
    let o = nc * 4;
    const [cx, cy] = groupCentre(this.meta, gx, gy), ex = this.meta.vert_exag;
    for (let k = 0; k < nc; k++) {
      const n = counts[k];
      if (!n) continue;
      const a = new Int16Array(buf, o, n * 6);
      o += n * 12;
      const lift = 5 + (nc - k) * 0.6;                  // major roads sit on top of minor ones
      // minor roads: one line object per terrain tile (3.84 km) so near / out-of-view tiles can be skipped; major
      // roads (seen from far away): one per group, or the draw calls add up
      const minor = ROAD_STYLE[this.classes[k]].maxDist <= 22000;
      const NT = minor ? 7 : 1, span = this.meta.group * this.meta.grid_res_m, tileM = span / NT;
      const buckets = new Map();
      for (let i = 0; i < n * 6; i += 6) {
        const mx = (a[i] + a[i + 3]) / 2, my = (a[i + 1] + a[i + 4]) / 2;
        const tx = Math.min(NT - 1, Math.max(0, Math.floor((mx + span / 2) / tileM)));
        const ty = Math.min(NT - 1, Math.max(0, Math.floor((span / 2 - my) / tileM)));
        const key = ty * NT + tx;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
      }
      for (const [key, list] of buckets) {
        const pos = new Float32Array(list.length * 6);
        list.forEach((i, j) => {
          for (let e = 0; e < 6; e += 3) {
            pos[j * 6 + e] = cx + a[i + e];
            pos[j * 6 + e + 1] = (a[i + e + 2] / 10) * ex + lift;
            pos[j * 6 + e + 2] = -(cy + a[i + e + 1]);
          }
        });
        const line = new LineSegments2(new LineSegmentsGeometry().setPositions(pos), this.materials[k]);
        if (ROAD_STYLE[this.classes[k]].dashed) line.computeLineDistances();
        line.renderOrder = 10 + (nc - k);
        const tx = key % NT, ty = Math.floor(key / NT);
        this.addCell(gx, gy, line, ROAD_STYLE[this.classes[k]].maxDist * this.distScale,
                     [cx - span / 2 + (tx + 0.5) * tileM, cy + span / 2 - (ty + 0.5) * tileM], tileM / 2);
      }
    }
  }
}

// ---------------------------------------------------------------- landmarks
/** Places of worship: one InstancedMesh per kind; userData.items maps instanceId -> landmark record. */
export function buildLandmarks(list, meta, heroes = [], excluded = []) {
  const models = landmarkModels(meta.building_exag);
  const group = new THREE.Group();
  group.name = 'landmarks';
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  mat.onBeforeCompile = (sh) => patchCloudShadow(sh, cloudUniforms());   // cloud shade, wet in the rain
  const byKind = {};
  const replaced = new Set([...excluded, ...heroes.flatMap(L => L.replaces || [])]);
  for (const L of list) if (!replaced.has(L.name)) (byKind[L.kind] ||= []).push(L);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), y = new THREE.Vector3(0, 1, 0);
  for (const [kind, items] of Object.entries(byKind)) {
    const im = new THREE.InstancedMesh(models[kind], mat, items.length);
    items.forEach((L, i) => {
      q.setFromAxisAngle(y, L.rot - Math.PI / 2);
      m4.compose(new THREE.Vector3(L.x, L.z * meta.vert_exag - 0.5, -L.y), q, new THREE.Vector3(1, 1, 1));
      im.setMatrixAt(i, m4);
    });
    im.computeBoundingSphere();
    im.userData.items = items;
    group.add(im);
  }
  return group;
}
