// Quiet moorings at proven canal-side houses; physical placement is estimated.
// Ordinary static instance matrices work in the automatic shadow/reflection passes.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cloudUniforms, patchCloudShadow } from './render/atmosphere.js';
import { warm } from './render/warmup.js';

const RANGE = 250, CELL = 200, MAX_BOATS = 6, MAX_CALLS = 4, MAX_TRIANGLES = 24999;
const SUPPORT_RANGE = 180, MAX_SUPPORT_HOUSES = 12;
const SAMPLE_OFFSETS = [[0,0],[-.5,-.5],[-.5,.5],[.5,-.5],[.5,.5],[0,-.5],[0,.5],[-.5,0],[.5,0]];

/** The builder proved a padded whole footprint against corrected houses and road ribbons. */
export function approvedBoatAnchor(record) {
  const b = record?.boat;
  return b?.approved === true && b.confidence === 'estimated' && typeof b.proof === 'string' && b.proof.length > 0
    && [b.x,b.north,b.front_rad,b.width_m,b.depth_m,b.water_min,b.building_clearance_m,b.road_clearance_m].every(Number.isFinite)
    && b.width_m >= 2.1 && b.depth_m >= 5.6 && b.water_min >= .55
    && b.building_clearance_m >= .75 && b.road_clearance_m >= 1
    && Array.isArray(b.water_samples) && b.water_samples.length === 9
    && b.water_samples.every(w => Number.isFinite(w) && w >= .55);
}

/** Recheck the same nine full-envelope samples using the viewer's current water map. */
export function boatFootprintIsWater(anchor, surface) {
  if (!surface?.waterAt) return false;
  const c = Math.cos(anchor.front_rad), s = Math.sin(anchor.front_rad);
  return SAMPLE_OFFSETS.every(([across,along]) => {
    const a = across * anchor.width_m, b = along * anchor.depth_m;
    const w = surface.waterAt(anchor.x+c*b-s*a,anchor.north+s*b+c*a);
    return Number.isFinite(w) && w >= .55;
  });
}

/** Only extend a generated rear post whose actual nominal lower end is above water. */
export function wetRearSupportExtensions(house, terrain, ex = 1) {
  if (!house?.requires_stilts || ![4,5].includes(house.style) || !terrain.surface?.waterAt
      || ![house.x,house.north,house.width_m,house.depth_m,house.front_rad,ex].every(Number.isFinite)
      || house.width_m <= .6 || house.depth_m <= .6) return [];
  const ground = terrain.heightAt(house.x,house.north)*ex;
  // houses.js puts iA.y .30 m below centre ground, then its posts extend another 1.50 m.
  const nominalBottom = ground-1.8, top = ground-1.5+.05;
  if (!Number.isFinite(top)) return [];
  const c = Math.cos(house.front_rad), s = Math.sin(house.front_rad), rear = -house.depth_m/2+.18, posts = [];
  for (const side of [-1,1]) {
    const across = side*(house.width_m/2-.18);
    const x = house.x+c*rear-s*across, north = house.north+s*rear+c*across;
    const water = terrain.waterHeightAt(x,north), land = terrain.heightAt(x,north)*ex;
    const wet = terrain.surface.waterAt(x,north);
    if (!Number.isFinite(wet) || wet < .55 || !Number.isFinite(water) || !Number.isFinite(land) || nominalBottom <= water+.02) continue;
    const bottom = Math.min(land,water)-.2;
    if (top > bottom) posts.push({x,north,bottom,top,front_rad:house.front_rad});
  }
  return posts;
}

async function json(url) {
  const r = await fetch(url); if (!r.ok) throw Error(`Canal access unavailable: ${url}`); return r.json();
}

export class CanalAccessLayer {
  constructor(meta, terrain, { dataUrl = 'data/', modelsUrl = 'models/canal-access/', mobile = false, supports = true } = {}) {
    this.meta = meta; this.terrain = terrain; this.dataUrl = dataUrl; this.modelsUrl = modelsUrl;
    this.enabled = !mobile; this.ready = false; this.dead = false; this.cells = new Map();
    this.group = new THREE.Group(); this.group.name = 'canal-access';
    this.supportGroup = new THREE.Group(); this.supportGroup.name = 'canal-supports';
    this.supports = supports; this.supportCells = new Map(); this.supportSelection = '';
    this.frustum = new THREE.Frustum(); this.vp = new THREE.Matrix4(); this.selection = '';
    this.stats = { instances: 0, triangles: 0, calls: 0, anchors: 0, textureBytes: 0 };
    this.supportStats = { houses: 0, posts: 0, triangles: 0, calls: 0 };
  }

  async load() {
    if (!this.enabled || this.dead) return;
    const [data,kit] = await Promise.all([json(this.dataUrl+'canal-houses.json'),json(this.modelsUrl+'kit.json')]);
    if (data.schema !== 1 || kit.schema !== 1 || !Array.isArray(data.records)) throw Error('Unsupported canal access data');
    if (data.centre_utm && data.centre_utm.some((v,i) => Math.abs(v-this.meta.centre_utm[i]) > .01)) throw Error('Canal access map centre mismatch');
    const anchors = data.records.filter(approvedBoatAnchor).map((r,i) => ({ ...r.boat, key: i }));
    this.stats.anchors = anchors.length;
    if (this.dead) return;
    if (this.supports) {
      for (const [i,h] of data.records.entries()) {
        if (!h.requires_stilts || ![4,5].includes(h.style) || ![h.x,h.north,h.front_rad,h.width_m,h.depth_m].every(Number.isFinite)) continue;
        const key = `${Math.floor(h.x/CELL)}_${Math.floor(h.north/CELL)}`;
        if (!this.supportCells.has(key)) this.supportCells.set(key,[]); this.supportCells.get(key).push({...h,key:i});
      }
      this.supportGeometry = new THREE.BoxGeometry(1,1,1);
      this.supportMaterial = new THREE.MeshStandardMaterial({color:0x615143,roughness:.9,metalness:0});
      this.supportMaterial.onBeforeCompile = sh => patchCloudShadow(sh,cloudUniforms());
      this.supportMaterial.customProgramCacheKey = () => 'canal-post-extension-v1';
      this.supportMesh = new THREE.InstancedMesh(this.supportGeometry,this.supportMaterial,MAX_SUPPORT_HOUSES*2);
      this.supportMesh.name = 'wet-rear-post-extensions'; this.supportMesh.count = 0; this.supportMesh.raycast = () => {};
      this.supportMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.supportMesh.castShadow = true; this.supportMesh.receiveShadow = true; this.supportGroup.add(this.supportMesh);
      await warm(this.supportMesh);
    }
    if (!anchors.length) { if (!this.dead) this.ready = true; return; }
    const gltf = await new GLTFLoader().loadAsync(this.modelsUrl+kit.file), parts = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
      if (!geometry.attributes.color) throw Error('Canal sampan needs its original painted colours');
      for (const key of Object.keys(geometry.attributes)) if (!['position','normal','color'].includes(key)) geometry.deleteAttribute(key);
      parts.push(geometry);
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of materials) { for (const key of ['map','normalMap','roughnessMap','metalnessMap']) m[key]?.dispose(); m.dispose(); }
      o.geometry.dispose();
    });
    this.geometry = mergeGeometries(parts,false); parts.forEach(p => p.dispose());
    if (!this.geometry) throw Error('Canal sampan mesh attributes differ');
    this.geometry.computeBoundingBox(); this.modelBox = this.geometry.boundingBox;
    const width = this.modelBox.max.x-this.modelBox.min.x, depth = this.modelBox.max.z-this.modelBox.min.z;
    this.triangles = (this.geometry.index?.count || this.geometry.attributes.position.count)/3;
    this.cap = Math.min(MAX_BOATS,Math.floor(MAX_TRIANGLES/this.triangles));
    if (!this.cap || !Number.isFinite(this.triangles) || width > 2.1 || depth > 5.6) throw Error('Canal sampan exceeds its proven footprint or budget');
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .84, metalness: 0 });
    this.material.onBeforeCompile = sh => patchCloudShadow(sh,cloudUniforms());
    this.material.customProgramCacheKey = () => 'canal-sampan-static-v1';
    this.mesh = new THREE.InstancedMesh(this.geometry,this.material,this.cap);
    this.mesh.name = 'moored-blue-sampans'; this.mesh.count = 0; this.mesh.raycast = () => {};
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // No noShadow flag: the near moorings cast/receive shadows and appear in reflections.
    this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.group.add(this.mesh);
    for (const a of anchors) {
      const key = `${Math.floor(a.x/CELL)}_${Math.floor(a.north/CELL)}`;
      if (!this.cells.has(key)) this.cells.set(key,[]); this.cells.get(key).push(a);
    }
    await warm(this.mesh);
    if (!this.dead) this.ready = true;
  }

  update(camera) {
    this.stats.instances = 0; this.stats.triangles = 0; this.stats.calls = 0;
    this.group.visible = this.ready && this.enabled && !this.dead;
    this.supportGroup.visible = this.group.visible && this.supports;
    if (!this.group.visible) return;
    const p = camera.position, surface = this.terrain.surface;
    this.vp.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this.vp);
    this.updateSupports(camera);
    if (!this.mesh) { this.group.visible = false; return; }
    const choices = [], box = new THREE.Box3(), matrix = new THREE.Matrix4();
    const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), up = new THREE.Vector3(0,1,0), scale = new THREE.Vector3(1,1,1);
    for (let ix=Math.floor((p.x-RANGE)/CELL);ix<=Math.floor((p.x+RANGE)/CELL);ix++) {
      for (let iy=Math.floor((-p.z-RANGE)/CELL);iy<=Math.floor((-p.z+RANGE)/CELL);iy++) {
        for (const a of this.cells.get(`${ix}_${iy}`)||[]) {
          const distance = Math.hypot(p.x-a.x,p.z+a.north); if (distance > RANGE) continue;
          if (a.checkedSurface !== surface) { a.waterOK = boatFootprintIsWater(a,surface); a.checkedSurface = surface; }
          if (!a.waterOK) continue;
          const height = this.terrain.waterHeightAt(a.x,a.north); if (!Number.isFinite(height)) continue;
          rotation.setFromAxisAngle(up,Math.atan2(Math.cos(a.front_rad),-Math.sin(a.front_rad)));
          matrix.compose(position.set(a.x,height,-a.north),rotation,scale);
          box.copy(this.modelBox).applyMatrix4(matrix);
          if (!this.frustum.intersectsBox(box)) continue;
          choices.push({ anchor: a, distance, height, matrix: matrix.clone(), box: box.clone() });
        }
      }
    }
    choices.sort((a,b) => a.distance-b.distance || a.anchor.key-b.anchor.key);
    const shown = [];
    for (const choice of choices) {
      // Neighbouring safe house anchors can still describe the same mooring space.
      if (shown.some(v => v.box.intersectsBox(choice.box))) continue;
      shown.push(choice); if (shown.length >= this.cap) break;
    }
    const selection = shown.map(a => `${a.anchor.key}:${a.height}`).join(',');
    if (selection !== this.selection) {
      const bounds = new THREE.Box3();
      shown.forEach((v,i) => { this.mesh.setMatrixAt(i,v.matrix); bounds.union(v.box); });
      this.mesh.count = shown.length; this.mesh.instanceMatrix.needsUpdate = true;
      if (shown.length) { this.mesh.computeBoundingSphere(); this.group.userData.occBox = bounds.expandByScalar(.3); }
      this.selection = selection;
    }
    this.mesh.visible = shown.length > 0;
    Object.assign(this.stats,{instances:shown.length,triangles:shown.length*this.triangles,calls:shown.length ? 1 : 0});
  }

  updateSupports(camera) {
    Object.assign(this.supportStats,{houses:0,posts:0,triangles:0,calls:0});
    if (!this.supportMesh) return;
    const p = camera.position, choices = [];
    for (let ix=Math.floor((p.x-SUPPORT_RANGE)/CELL);ix<=Math.floor((p.x+SUPPORT_RANGE)/CELL);ix++) {
      for (let iy=Math.floor((-p.z-SUPPORT_RANGE)/CELL);iy<=Math.floor((-p.z+SUPPORT_RANGE)/CELL);iy++) {
        for (const h of this.supportCells.get(`${ix}_${iy}`)||[]) {
          const distance = Math.hypot(p.x-h.x,p.z+h.north); if (distance > SUPPORT_RANGE) continue;
          const posts = wetRearSupportExtensions(h,this.terrain,this.meta.vert_exag);
          if (!posts.length) continue;
          const box = new THREE.Box3();
          for (const post of posts) { box.expandByPoint(new THREE.Vector3(post.x-.17,post.bottom,-post.north-.17)); box.expandByPoint(new THREE.Vector3(post.x+.17,post.top,-post.north+.17)); }
          if (this.frustum.intersectsBox(box)) choices.push({h,posts,box,distance});
        }
      }
    }
    choices.sort((a,b) => a.distance-b.distance || a.h.key-b.h.key);
    const shown = choices.slice(0,MAX_SUPPORT_HOUSES), selection = shown.map(v => v.h.key+':'+v.posts.map(p => p.bottom+':'+p.top).join(',')).join(';');
    const count = shown.reduce((n,v) => n+v.posts.length,0);
    if (selection !== this.supportSelection) {
      const box = new THREE.Box3(), matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), up = new THREE.Vector3(0,1,0), scale = new THREE.Vector3(); let i=0;
      for (const v of shown) {
        for (const post of v.posts) {
          rotation.setFromAxisAngle(up,Math.atan2(Math.cos(post.front_rad),-Math.sin(post.front_rad)));
          matrix.compose(position.set(post.x,(post.top+post.bottom)/2,-post.north),rotation,scale.set(.24,post.top-post.bottom,.24));
          this.supportMesh.setMatrixAt(i++,matrix);
        }
        box.union(v.box);
      }
      this.supportMesh.count = count; this.supportMesh.instanceMatrix.needsUpdate = true;
      if (count) {this.supportMesh.computeBoundingSphere();this.supportGroup.userData.occBox = box.expandByScalar(.3);}
      this.supportSelection = selection;
    }
    this.supportMesh.visible = count > 0;
    Object.assign(this.supportStats,{houses:shown.length,posts:count,triangles:count*12,calls:count ? 1 : 0});
  }

  dispose() {
    this.dead = true; this.ready = false; this.group.clear(); this.group.removeFromParent();
    this.mesh?.dispose(); this.geometry?.dispose(); this.material?.dispose(); this.cells.clear();
    this.supportGroup.clear(); this.supportGroup.removeFromParent(); this.supportMesh?.dispose(); this.supportGeometry?.dispose(); this.supportMaterial?.dispose(); this.supportCells.clear();
  }
}
