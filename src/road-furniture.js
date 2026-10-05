// Original QCVN2019 roadside assets; placements inferred from existing OSM, not a sign survey.
// Static instance transforms keep the normal shadow/depth pass correct. Only UVs vary per instance.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cloudUniforms, patchCloudShadow } from './render/atmosphere.js';

const CELL = 200, RANGE = 450, NEAR = 140, MAX_CALLS = 16, MAX_TRIANGLES = 25000;
const BASE = 'models/road-furniture/';

export class RoadFurnitureLayer {
  constructor(meta, terrain, { dataUrl = 'data/', mobile = false, roads3d = null } = {}) {
    this.meta = meta; this.terrain = terrain; this.dataUrl = dataUrl; this.roads3d = roads3d;
    this.enabled = !mobile; this.ready = false; this.tick = 0;
    this.group = new THREE.Group(); this.group.name = 'road-furniture';
    this.cells = new Map(); this.built = new Map(); this.frustum = new THREE.Frustum(); this.vp = new THREE.Matrix4();
    this.stats = { calls: 0, triangles: 0, instances: 0, textureBytes: 0 };
  }

  async load() {
    if (!this.enabled) return;
    const [data, kit] = await Promise.all([
      fetch(`${this.dataUrl}road-furniture.json`).then(r => { if (!r.ok) throw Error('Road furniture data unavailable'); return r.json(); }),
      fetch(`${BASE}kit.json`).then(r => { if (!r.ok) throw Error('Road furniture kit unavailable'); return r.json(); }),
    ]);
    if (data.version !== 1 || kit.version !== 1) throw Error('Unsupported road furniture format');
    if (data.centre_utm.some((v,i) => Math.abs(v-this.meta.centre_utm[i]) > .01)) throw Error('Road furniture map centre mismatch');
    const atlas = await new THREE.TextureLoader().loadAsync(`${BASE}${kit.atlas.file}`);
    atlas.colorSpace = THREE.SRGBColorSpace; atlas.flipY = false; atlas.anisotropy = 2;
    this.material = new THREE.MeshStandardMaterial({ map: atlas, roughness: .78, metalness: 0, side: THREE.DoubleSide });
    this.material.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 rfFaceUv;\nattribute vec4 rfRect;\nattribute float rfPostBlue;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          if (rfFaceUv.x >= 0.0) vMapUv = rfRect.xy + rfFaceUv * rfRect.zw;
          else if (rfFaceUv.x < -1.5) vMapUv = vec2(mix(192.0,320.0,rfPostBlue)/2048.0,32.0/2048.0);`);
      patchCloudShadow(sh, cloudUniforms());
    };
    this.material.customProgramCacheKey = () => 'cuulong-road-furniture-atlas-v1';
    this.models = new Map(); const loader = new GLTFLoader();
    await Promise.all(kit.models.flatMap(model => ['near','far'].map(async lod => {
      const gltf = await loader.loadAsync(`${BASE}${model[lod].file}`); let object;
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse(o => { if (o.isMesh && !object) object = o; });
      if (!object || !object.geometry.attributes.uv1) throw Error(`Furniture model lacks FaceUV: ${model.id}/${lod}`);
      const geo = object.geometry.clone().applyMatrix4(object.matrixWorld);
      geo.setAttribute('rfFaceUv', geo.attributes.uv1.clone()); geo.computeBoundingBox();
      this.models.set(`${model.id}/${lod}`, { geometry: geo, triangles: (geo.index?.count || geo.attributes.position.count)/3 });
      // Shared external atlas is the only production texture allocation.
      gltf.scene.traverse(o => { if (o.isMesh) { const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) { for (const key of ['map','normalMap','roughnessMap','metalnessMap']) mat[key]?.dispose(); mat.dispose(); }
        o.geometry.dispose(); } });
    })));
    for (const row of data.records) {
      const key = `${Math.floor(row.x/CELL)}_${Math.floor(row.north/CELL)}`;
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(row);
    }
    this.stats.textureBytes = kit.atlas.rgba_mip_bytes; this.kit = kit; this.ready = true;
  }

  build(key) {
    const rows = this.cells.get(key), [ix,iy] = key.split('_').map(Number);
    const cx = (ix+.5)*CELL, north = (iy+.5)*CELL;
    const group = new THREE.Group(); group.position.set(cx,0,-north);
    const byKind = new Map(); const box = new THREE.Box3();
    for (const row of rows) {
      // Shoulder signs must remain on land. Bridge plaques were put on a connected land approach.
      if (this.terrain.surface?.waterAt(row.x,row.north) > .65 || this.terrain.wetland?.floodAt(row.x,row.north) > .4) continue;
      if (!byKind.has(row.model)) byKind.set(row.model, []);
      byKind.get(row.model).push(row);
    }
    const parts = [];
    for (const [kind, records] of byKind) {
      const near = this.models.get(`${kind}/near`), far = this.models.get(`${kind}/far`);
      if (!near || !far) continue;
      const matrices = records.map(row => {
        // (Claude Code) on the road's embankment, not in the ground below it: roads3d.js surfaceAt
        const top = this.roads3d?.surfaceAt(row.x,row.north), terrainH = this.terrain.heightAt(row.x,row.north)*this.meta.vert_exag;
        const h = top ? Math.max(top.h, terrainH) : terrainH, px = top ? top.x : row.x, pn = top ? top.north : row.north;
        const m = new THREE.Matrix4().compose(new THREE.Vector3(px-cx,h,-pn+north),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),row.yaw), new THREE.Vector3(1,1,1));
        box.union(near.geometry.boundingBox.clone().applyMatrix4(m)); return m;
      });
      for (const lod of ['near','far']) {
        const model = lod === 'near' ? near : far;
        const geo = model.geometry.clone();
        geo.setAttribute('rfRect',new THREE.InstancedBufferAttribute(new Float32Array(records.length*4),4));
        geo.setAttribute('rfPostBlue',new THREE.InstancedBufferAttribute(new Float32Array(records.length),1));
        const mesh = new THREE.InstancedMesh(geo,this.material,records.length);
        mesh.name = `road-furniture-${kind}-${lod}`; mesh.count = 0; mesh.visible = false; mesh.raycast = () => {};
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.userData.noShadow = lod === 'far';
        mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere()); mesh.computeBoundingSphere = () => {};
        group.add(mesh); parts.push({ kind,lod,model,records,matrices,mesh });
      }
    }
    if (!box.isEmpty()) group.userData.occBox = box.clone().translate(group.position).expandByScalar(.3);
    this.group.add(group); const cell = { group,parts,used:this.tick };
    this.built.set(key,cell); return cell;
  }

  update(camera) {
    this.group.visible = this.ready && this.enabled;
    this.stats.calls = 0; this.stats.triangles = 0; this.stats.instances = 0;
    if (!this.group.visible) return;
    this.tick++;
    const p = camera.position;
    this.vp.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this.vp);
    for (const cell of this.built.values()) cell.group.visible = false;
    const choices = [];
    for (let ix=Math.floor((p.x-RANGE)/CELL);ix<=Math.floor((p.x+RANGE)/CELL);ix++) {
      for (let iy=Math.floor((-p.z-RANGE)/CELL);iy<=Math.floor((-p.z+RANGE)/CELL);iy++) {
        const key=`${ix}_${iy}`; if (!this.cells.has(key)) continue;
        const distance=Math.hypot(Math.max(Math.abs(p.x-(ix+.5)*CELL)-CELL/2,0),Math.max(Math.abs(-p.z-(iy+.5)*CELL)-CELL/2,0));
        if (distance<=RANGE) choices.push({ key,distance });
      }
    }
    choices.sort((a,b) => a.distance-b.distance || a.key.localeCompare(b.key));
    for (const choice of choices) {
      const cell=this.built.get(choice.key)||this.build(choice.key); cell.used=this.tick;
      if (!cell.group.userData.occBox || !this.frustum.intersectsBox(cell.group.userData.occBox)) continue;
      cell.group.visible=true;
      for (const part of cell.parts) {
        const {mesh,records,lod,model}=part; mesh.count=0; mesh.visible=false;
        if (this.stats.calls>=MAX_CALLS) continue;
        const rect=mesh.geometry.attributes.rfRect, cap=mesh.geometry.attributes.rfPostBlue;
        for (let i=0;i<records.length;i++) {
          const row=records[i], d=Math.hypot(p.x-row.x,p.z+row.north);
          if (d>RANGE || (lod==='near' ? d>NEAR : d<=NEAR)) continue;
          if (this.stats.triangles+model.triangles>MAX_TRIANGLES) break;
          mesh.setMatrixAt(mesh.count,part.matrices[i]); rect.setXYZW(mesh.count,...row.atlas_rect);
          cap.setX(mesh.count,row.post_colour==='blue' ? 1 : 0); mesh.count++;
          this.stats.triangles+=model.triangles; this.stats.instances++;
        }
        if (mesh.count) {
          mesh.visible=true; mesh.instanceMatrix.needsUpdate=true; rect.needsUpdate=true; cap.needsUpdate=true; this.stats.calls++;
        }
      }
    }
    // Geometry cache is bounded on long trips; shared models/material/atlas stay resident.
    for (const [key,cell] of this.built) if (this.built.size>64 && this.tick-cell.used>120) {
      this.group.remove(cell.group); for (const p of cell.parts) {p.mesh.geometry.dispose();p.mesh.dispose();} this.built.delete(key);
    }
  }
}
