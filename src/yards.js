// Estimated province-wide plot fronts and garden/empty-lot detail from scripts/yards.py.
// Static InstancedMesh matrices: cut-out depth/shadow materials work without custom vertex code.
// No far geometry. Main-pass ceilings apply before frustum/occlusion culling: 40 draws / 300k triangles.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cloudUniforms, patchCloudShadow } from './render/atmosphere.js';

const CELL = 100, RANGE = 230, WEED_RANGE = 150;
const MAX_CALLS = 40, MAX_TRIANGLES = 300000, MAX_CELLS = 24;

export class YardLayer {
  constructor(meta, terrain, { dataUrl = 'data/', mobile = false } = {}) {
    this.meta = meta; this.terrain = terrain; this.dataUrl = dataUrl;
    this.enabled = !mobile; this.ready = false;
    this.group = new THREE.Group(); this.group.name = 'yards';
    this.groups = new Map(); this.cells = new Map(); this.tick = 0;
    this.stats = { triangles: 0, calls: 0, instances: 0, cells: 0, atlasMipBytes: 2048 * 2048 * 4 * 4 / 3 };
    this.frustum = new THREE.Frustum(); this.vp = new THREE.Matrix4();
  }

  async load() {
    if (!this.enabled) return;                 // phones: off, no atlas/data requests
    const [index, kit, gltf] = await Promise.all([
      fetch(`${this.dataUrl}yards/index.json`).then(r => { if (!r.ok) throw Error('Yard index unavailable'); return r.json(); }),
      fetch('models/yards/kit.json').then(r => r.json()),
      new GLTFLoader().loadAsync('models/yards/yards.glb'),
    ]);
    this.index = index; this.kit = kit;
    if (index.cell_m !== CELL) throw Error('Unsupported yard cell size');
    const objects = new Map();
    gltf.scene.traverse(o => { if (o.isMesh) objects.set(o.name, o); });
    this.models = index.models.map(id => {
      const mesh = objects.get(id);
      if (!mesh) throw Error(`Missing yard model: ${id}`);
      mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingBox();
      return { geometry: mesh.geometry, triangles: mesh.geometry.index.count / 3,
               kind: kit.models.find(m => m.id === id).kind, id };
    });
    // All nodes share one atlas/material. Standard alphaTest+map makes the automatic cut-out shadows.
    const mat = objects.values().next().value.material;
    mat.alphaTest = .45; mat.side = THREE.DoubleSide; mat.roughness = .84; mat.metalness = 0;
    mat.flatShading = false; mat.needsUpdate = true;
    mat.onBeforeCompile = sh => patchCloudShadow(sh, cloudUniforms());
    mat.customProgramCacheKey = () => 'cuulong-yard-atlas-v1';
    this.material = mat;
    if (mat.map) mat.map.anisotropy = 2;
    this.ready = true;
  }

  request(g) {
    const key = `${g.gx}_${g.gy}`;
    if (this.groups.has(key)) return;
    const state = { data: null, used: this.tick }; this.groups.set(key, state);
    fetch(`${this.dataUrl}yards/${g.file}`).then(r => {
      if (!r.ok) throw Error('Yard group unavailable');
      return new Response(r.body.pipeThrough(new DecompressionStream('deflate'))).json();
    }).then(d => { state.data = d.cells; })
      .catch(e => { state.error = true; console.warn('Yards:', e.message); });
  }

  build(key, records) {
    const [ix, iy] = key.split('_').map(Number), cx = (ix + .5) * CELL, north = (iy + .5) * CELL;
    const group = new THREE.Group(); group.position.set(cx, 0, -north);
    const byType = new Map();
    for (const row of records) {
      const [id, x, y] = row;
      // Repeat the runtime water/rice and Trà Sư exclusion, including mixed shoreline pixels.
      if (this.terrain.surface && (this.terrain.surface.waterAt(x,y) > .30 || this.terrain.surface.cropAt(x,y) > .30)) continue;
      if (this.terrain.wetland?.floodAt(x,y) > .2) continue;
      if (!byType.has(id)) byType.set(id, []);
      byType.get(id).push(row);
    }
    const parts = [], box = new THREE.Box3();
    for (const [id, rows] of byType) {
      const model = this.models[id], mesh = new THREE.InstancedMesh(model.geometry, this.material, rows.length);
      mesh.name = `yard-${model.id}`; mesh.count = 0; mesh.raycast = () => {};
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const matrices = rows.map(row => {
        const [,x,y,a,sx,sy,sz] = row;
        const height = this.terrain.heightAt(x,y) * this.meta.vert_exag - .03;
        const m = new THREE.Matrix4().compose(new THREE.Vector3(x-cx,height,-(y-north)),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),a), new THREE.Vector3(sx,sy,sz));
        box.union(model.geometry.boundingBox.clone().applyMatrix4(m));
        return m;
      });
      mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      // Bounding sphere encompasses the whole cell; do not recalculate it from the changing compacted count.
      mesh.computeBoundingSphere = () => {};
      mesh.visible = false;
      group.add(mesh); parts.push({ mesh, rows, matrices, model });
    }
    if (!box.isEmpty()) group.userData.occBox = box.clone().translate(group.position).expandByScalar(.2);
    this.group.add(group);
    const cell = { key, group, parts, used: this.tick, recordCount: records.length };
    this.cells.set(key, cell); return cell;
  }

  update(camera) {
    if (!this.ready || !this.enabled) {
      this.group.visible = false;
      this.stats = { ...this.stats, triangles: 0, calls: 0, instances: 0, cells: 0 };
      return;
    }
    this.group.visible = true; this.tick++;
    const p = camera.position;
    this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this.vp);
    // Select nearest cells, not every record in the loaded 27 km group. Only lazy-build relevant cells.
    const choices = new Map(), r = RANGE;
    for (const g of this.index.groups) {
      const [x0,y0,x1,y1] = g.bounds;
      if (p.x < x0-r || p.x > x1+r || -p.z < y0-r || -p.z > y1+r || p.y > 800 * this.meta.vert_exag) continue;
      this.request(g);
      const state = this.groups.get(`${g.gx}_${g.gy}`); state.used = this.tick;
      if (!state.data) continue;
      for (let x = Math.floor((p.x-r)/CELL); x <= Math.floor((p.x+r)/CELL); x++) {
        for (let y = Math.floor((-p.z-r)/CELL); y <= Math.floor((-p.z+r)/CELL); y++) {
          const key = `${x}_${y}`, rows = state.data[key]; if (!rows) continue;
          const dx = Math.max(Math.abs(p.x-(x+.5)*CELL)-CELL/2,0);
          const dz = Math.max(Math.abs(p.z+(y+.5)*CELL)-CELL/2,0);
          const dist = Math.hypot(dx,dz); if (dist > r) continue;
          if (choices.has(key)) choices.get(key).rows.push(...rows);
          else choices.set(key,{ key, rows: [...rows], dist });
        }
      }
    }
    const selected = [...choices.values()].sort((a,b) => a.dist-b.dist || a.key.localeCompare(b.key));
    for (const cell of this.cells.values()) cell.group.visible = false;
    let calls = 0, triangles = 0, instances = 0, drawnCells = 0;
    for (const choice of selected) {
      let cell = this.cells.get(choice.key);
      if (cell && cell.recordCount !== choice.rows.length) {
        this.group.remove(cell.group); cell.parts.forEach(p => p.mesh.dispose()); this.cells.delete(choice.key); cell = null;
      }
      if (!cell) cell = this.build(choice.key, choice.rows);
      cell.used = this.tick;
      if (!cell.group.userData.occBox || !this.frustum.intersectsBox(cell.group.userData.occBox)) continue;
      let shown = false;
      // Front boundaries before optional vegetation. Stable type order prevents random omissions.
      cell.parts.sort((a,b) => Number(a.model.kind === 'plant' || a.model.kind === 'weed') - Number(b.model.kind === 'plant' || b.model.kind === 'weed'));
      for (const part of cell.parts) {
        const { mesh, rows, matrices, model } = part;
        mesh.visible = false;
        if (calls >= MAX_CALLS) continue;
        let count = 0;
        for (let i = 0; i < rows.length; i++) {
          const [,x,y] = rows[i], height = matrices[i].elements[13];
          if (Math.hypot(p.x-x,p.z+y,p.y-height) > (model.kind === 'weed' ? WEED_RANGE : RANGE)) continue;
          if (triangles+model.triangles > MAX_TRIANGLES) break;
          mesh.setMatrixAt(count++,matrices[i]); triangles += model.triangles;
        }
        mesh.count = count;
        if (count) { mesh.instanceMatrix.needsUpdate = true; mesh.visible = true; calls++; instances += count; shown = true; }
      }
      cell.group.visible = shown; if (shown) drawnCells++;
      if (calls >= MAX_CALLS || triangles >= MAX_TRIANGLES || drawnCells >= MAX_CELLS) break;
    }
    this.stats = { ...this.stats, calls, triangles, instances, cells: drawnCells };
    // Bound GPU matrices and CPU group records during travel. Geometry/material/atlas remain shared.
    if (this.cells.size > MAX_CELLS) {
      for (const cell of [...this.cells.values()].sort((a,b) => a.used-b.used)) {
        if (this.cells.size <= MAX_CELLS) break;
        if (cell.group.visible) continue;
        this.group.remove(cell.group); cell.parts.forEach(part => part.mesh.dispose()); this.cells.delete(cell.key);
      }
    }
    if (this.groups.size > 2) {
      for (const [key,state] of [...this.groups.entries()].sort((a,b) => a[1].used-b[1].used)) {
        if (this.groups.size <= 2) break;
        if (state.used < this.tick-300) this.groups.delete(key);
      }
    }
  }

  dispose() {
    for (const cell of this.cells.values()) cell.parts.forEach(part => part.mesh.dispose());
    this.group.clear(); this.cells.clear(); this.groups.clear();
    this.models?.forEach(m => m.geometry.dispose()); this.material?.map?.dispose(); this.material?.dispose();
  }
}
