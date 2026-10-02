// Trees, real buildings (Overture footprints as oriented boxes), roads and landmarks.
// Everything is stored per 26.9 km group; whole groups are hidden beyond a distance.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { treeModels, landmarkModels } from './models.js';

function groupCentre(meta, gx, gy) {
  const span = meta.group * meta.grid_res_m;
  const x0 = -meta.width_m / 2 + (gx * meta.group + 0.5) * meta.grid_res_m;
  const y0 = meta.height_m / 2 - (gy * meta.group + 0.5) * meta.grid_res_m;
  return [x0 + span / 2, y0 - span / 2];
}

/** Base for per-group layers: distance culling by the camera's distance to each group's square. */
class GroupLayer {
  constructor(name, meta) {
    this.meta = meta;
    this.group = new THREE.Group();
    this.group.name = name;
    this.cells = [];
  }
  addCell(gx, gy, obj, maxDistance) {
    const [cx, cy] = groupCentre(this.meta, gx, gy);
    this.cells.push({ obj, centre: new THREE.Vector3(cx, 0, -cy), maxDistance });
    this.group.add(obj);
  }
  update(camera) {
    const half = (this.meta.group * this.meta.grid_res_m) / 2;
    for (const c of this.cells) {
      const dx = Math.max(Math.abs(camera.position.x - c.centre.x) - half, 0);
      const dz = Math.max(Math.abs(camera.position.z - c.centre.z) - half, 0);
      c.obj.visible = Math.hypot(dx, dz, camera.position.y) < c.maxDistance;
    }
  }
}

// ---------------------------------------------------------------- trees
// File: int32 n | int16 x[n], y[n] (m, rel. group centre) | uint16 ground[n] (dm) | uint8 rot, scale, species
export class TreeLayer extends GroupLayer {
  constructor(meta, maxDistance) {
    super('trees', meta);
    this.maxDistance = maxDistance;
    this.models = treeModels();
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  }

  async loadCell(gx, gy, url) {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    const n = new DataView(buf).getInt32(0, true);
    let o = 4;
    const take = (T, b) => { const a = new T(buf, o, n); o += n * b; return a; };
    const x = take(Int16Array, 2), y = take(Int16Array, 2), h = take(Uint16Array, 2);
    const rot = take(Uint8Array, 1), scale = take(Uint8Array, 1), kind = take(Uint8Array, 1);
    const [cx, cy] = groupCentre(this.meta, gx, gy), ex = this.meta.vert_exag;
    const counts = new Array(this.models.length).fill(0);
    for (let i = 0; i < n; i++) counts[kind[i]]++;
    const cell = new THREE.Group();
    const meshes = counts.map((c, k) => {
      if (!c) return null;
      const m = new THREE.InstancedMesh(this.models[k], this.material, c);
      cell.add(m);
      return m;
    });
    const fill = new Array(this.models.length).fill(0);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    let seed = 1 + gx * 7919 + gy * 104729;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const m = meshes[kind[i]], slot = fill[kind[i]]++;
      p.set(cx + x[i], (h[i] / 10) * ex - 3, -(cy + y[i]));
      q.setFromAxisAngle(up, (rot[i] / 255) * Math.PI * 2);
      s.setScalar(0.5 + scale[i] / 255);
      m.setMatrixAt(slot, m4.compose(p, q, s));
      const b = 0.7 + rand() * 0.6;
      m.setColorAt(slot, col.setRGB(b, b, b));
    }
    for (const m of meshes) if (m) m.computeBoundingSphere();
    this.addCell(gx, gy, cell, this.maxDistance);
  }
}

// ---------------------------------------------------------------- real buildings
// File: int32 n | int16 x[n], y[n] (0.5 m, rel. group centre) | uint16 ground[n] (dm)
//   | uint8 width[n] (0.25 m) | depth[n] (0.5 m) | angle[n] (0..pi) | height[n] (0.25 m) | uint8 roof rgb[n*3]
export class BuildingLayer extends GroupLayer {
  constructor(meta, maxDistance) {
    super('buildings', meta);
    this.maxDistance = maxDistance;
    this.geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vUp;')
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          vUp = normalize((modelMatrix * instanceMatrix * vec4(objectNormal, 0.0)).xyz).y;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vUp;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          if (vUp < 0.5) diffuseColor.rgb = mix(vec3(0.62, 0.60, 0.56), diffuseColor.rgb, 0.2);  // plaster walls`);
    };
    mat.customProgramCacheKey = () => 'cuulong-buildings';
    this.material = mat;
  }

  async loadCell(gx, gy, url) {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    const n = new DataView(buf).getInt32(0, true);
    let o = 4;
    const take = (T, b, k = 1) => { const a = new T(buf, o, n * k); o += n * b * k; return a; };
    const x = take(Int16Array, 2), y = take(Int16Array, 2), g = take(Uint16Array, 2);
    const w = take(Uint8Array, 1), d = take(Uint8Array, 1), ang = take(Uint8Array, 1), ht = take(Uint8Array, 1);
    const roof = take(Uint8Array, 1, 3);
    const [cx, cy] = groupCentre(this.meta, gx, gy), ex = this.meta.vert_exag, bex = this.meta.building_exag;
    const im = new THREE.InstancedMesh(this.geometry, this.material, n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      p.set(cx + x[i] / 2, (g[i] / 10) * ex - 0.3, -(cy + y[i] / 2));
      q.setFromAxisAngle(up, (ang[i] / 255) * Math.PI + Math.PI / 2);   // box depth (local Z) along the long side
      s.set(w[i] / 4, (ht[i] / 4) * bex, d[i] / 2);
      im.setMatrixAt(i, m4.compose(p, q, s));
      im.setColorAt(i, col.setRGB(roof[i * 3] / 255, roof[i * 3 + 1] / 255, roof[i * 3 + 2] / 255, THREE.SRGBColorSpace));
    }
    im.computeBoundingSphere();
    this.addCell(gx, gy, im, this.maxDistance);
  }
}

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
  constructor(meta, distScale = 1) {
    super('roads', meta);
    this.classes = meta.road_classes;
    this.distScale = distScale;
    this.materials = this.classes.map((c) => {
      const st = ROAD_STYLE[c];
      const m = new LineMaterial({ color: st.color, linewidth: st.width, transparent: true, opacity: st.opacity,
                                   dashed: !!st.dashed, dashSize: 8, gapSize: 6, depthWrite: false });
      m.resolution.set(innerWidth, innerHeight);
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
      const pos = new Float32Array(n * 6);
      const lift = 5 + (nc - k) * 0.6;                  // major roads sit on top of minor ones
      for (let i = 0; i < n * 6; i += 3) {
        pos[i] = cx + a[i];
        pos[i + 1] = (a[i + 2] / 10) * ex + lift;
        pos[i + 2] = -(cy + a[i + 1]);
      }
      const line = new LineSegments2(new LineSegmentsGeometry().setPositions(pos), this.materials[k]);
      if (ROAD_STYLE[this.classes[k]].dashed) line.computeLineDistances();
      line.renderOrder = 10 + (nc - k);
      this.addCell(gx, gy, line, ROAD_STYLE[this.classes[k]].maxDist * this.distScale);
    }
  }
}

// ---------------------------------------------------------------- landmarks
/** Places of worship: one InstancedMesh per kind; userData.items maps instanceId -> landmark record. */
export function buildLandmarks(list, meta) {
  const models = landmarkModels(meta.building_exag);
  const group = new THREE.Group();
  group.name = 'landmarks';
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  const byKind = {};
  for (const L of list) (byKind[L.kind] ||= []).push(L);
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
