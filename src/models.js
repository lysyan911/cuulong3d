// Low-poly models built in code (no downloads), flat-shaded with vertex colours.
// Sizes follow the Blender scene: trees map-scale (height x3, crown ~x2.5), landmarks height x2. Y is up.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const lin = (r, g, b) => new THREE.Color(r, g, b);   // linear RGB

function part(geom, color, { x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, ry = 0 } = {}) {
  geom.scale(sx, sy, sz);
  if (ry) geom.rotateY(ry);
  geom.translate(x, y, z);
  let g = geom.index ? geom.toNonIndexed() : geom;
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');   // recomputed flat after merging
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function finish(parts) {
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

const cyl = (r, h, y0, seg = 6) => new THREE.CylinderGeometry(r, r, h, seg, 1, true).translate(0, y0 + h / 2, 0);
const box = (w, h, d, y0) => new THREE.BoxGeometry(w, h, d).translate(0, y0 + h / 2, 0);
const cone = (rBottom, rTop, h, y0, seg = 8) => new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1).translate(0, y0 + h / 2, 0);
const blob = (r, y) => new THREE.IcosahedronGeometry(r, 0).translate(0, y, 0);

/** Gable roof, ridge along Z (gable end faces the street). */
function gable(w, d, rise, y0, overhang = 0.6) {
  const hw = w / 2 + overhang, hd = d / 2 + overhang;
  const v = [[-hw, y0, -hd], [hw, y0, -hd], [hw, y0, hd], [-hw, y0, hd], [0, y0 + rise, -hd], [0, y0 + rise, hd]];
  const f = [[0, 4, 1], [2, 5, 3], [1, 4, 5], [1, 5, 2], [3, 5, 4], [3, 4, 0], [0, 1, 2], [0, 2, 3]];
  const pos = [];
  for (const t of f) for (const i of t) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 2).fill(0), 2));
  return g;
}

// ---------------------------------------------------------------- trees (ids = species in the data)
export function treeModels() {
  const bark = lin(0.09, 0.07, 0.05), paleBark = lin(0.30, 0.27, 0.22);
  return [
    /* 0 broadleaf */ finish([part(cyl(1.5, 22, 0), bark), part(blob(10, 31), lin(0.035, 0.085, 0.025), { sy: 1.4 })]),
    /* 1 tram      */ finish([part(cyl(0.8, 42, 0), paleBark), part(blob(4.5, 47), lin(0.065, 0.10, 0.05), { sy: 3.0 })]),
    /* 2 coconut   */ finish([part(cyl(0.7, 44, 0), bark), part(cone(11, 1.5, 5, 41.5), lin(0.075, 0.14, 0.03))]),
    /* 3 areca     */ finish([part(cyl(0.45, 50, 0), bark), part(cone(5, 0.8, 6, 47), lin(0.06, 0.13, 0.03))]),
    /* 4 fruit     */ finish([part(cyl(1.2, 9, 0), bark), part(blob(9, 16), lin(0.04, 0.11, 0.025), { sy: 0.9 })]),
    /* 5 bamboo    */ finish([part(cyl(1.0, 6, 0), bark), part(cone(3, 9, 34, 5), lin(0.11, 0.17, 0.04))]),
    /* 6 thot_not  */ finish([part(cyl(0.9, 62, 0), bark), part(blob(7, 66), lin(0.07, 0.12, 0.035), { sy: 0.85 })]),
  ];
}

// ---------------------------------------------------------------- landmarks (places of worship)
export function landmarkModels(E = 2) {
  const c = {
    cream: lin(0.82, 0.66, 0.30), khmerRoof: lin(0.70, 0.22, 0.04), gold: lin(0.85, 0.55, 0.08), white: lin(0.85, 0.85, 0.82),
    redTile: lin(0.45, 0.10, 0.05), grey: lin(0.45, 0.45, 0.45), dome: lin(0.10, 0.45, 0.40), yellow: lin(0.88, 0.70, 0.15),
    platform: lin(0.55, 0.50, 0.42),
  };
  const sphere = (r, y, sy = 1) => new THREE.SphereGeometry(r, 16, 8).scale(1, sy, 1).translate(0, y, 0);
  return {
    khmer_pagoda: finish([
      part(box(24, 1.5 * E, 38, 0), c.platform), part(box(16, 6 * E, 30, 1.5 * E), c.cream),
      part(gable(16, 30, 5 * E, 7.5 * E, 2.0), c.khmerRoof), part(gable(10, 22, 5 * E, 10.5 * E, 1.0), c.khmerRoof),
      part(cone(1.4, 0.05, 9 * E, 14 * E), c.gold),
      part(cone(0.8, 0.05, 5 * E, 12.5 * E), c.gold, { z: -13 }), part(cone(0.8, 0.05, 5 * E, 12.5 * E), c.gold, { z: 13 }),
    ]),
    viet_pagoda: finish([
      part(box(18, 0.8 * E, 24, 0), c.platform), part(box(14, 5 * E, 20, 0.8 * E), c.cream),
      part(gable(14, 20, 4 * E, 5.8 * E, 1.8), c.redTile),
      part(box(5, 12 * E, 5, 0), c.cream, { z: -16 }), part(cone(4, 0.3, 3 * E, 12 * E, 4), c.redTile, { z: -16 }),
    ]),
    church: finish([
      part(box(12, 10 * E, 30, 0), c.white), part(gable(12, 30, 4 * E, 10 * E), c.grey),
      part(box(5, 22 * E, 5, 0), c.white, { z: -17 }), part(cone(3.6, 0.1, 10 * E, 22 * E), c.grey, { z: -17 }),
    ]),
    mosque: finish([
      part(box(15, 7 * E, 15, 0), c.white), part(sphere(6, 7 * E, 1.4), c.dome),
      part(cyl(1.2, 24 * E, 0, 8), c.white, { x: 10, z: -8 }), part(sphere(1.6, 24 * E), c.dome, { x: 10, z: -8 }),
    ]),
    caodai: finish([
      part(box(14, 8 * E, 26, 0), c.yellow), part(gable(14, 26, 3 * E, 8 * E), c.redTile),
      part(box(4, 16 * E, 4, 0), c.yellow, { x: -5, z: -14 }), part(box(4, 16 * E, 4, 0), c.yellow, { x: 5, z: -14 }),
      part(cone(3, 0.2, 4 * E, 16 * E, 4), c.redTile, { x: -5, z: -14 }), part(cone(3, 0.2, 4 * E, 16 * E, 4), c.redTile, { x: 5, z: -14 }),
    ]),
  };
}
