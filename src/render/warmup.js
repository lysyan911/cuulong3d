// Shader warm-up (Claude Code, rendering).
//
// The first time a material is drawn, the browser compiles its shader program; on Windows (ANGLE / D3D) that can
// freeze the frame for 50-500 ms (measured: first view of Long Xuyên ~330 ms, Trà Sư ~530 ms). warm(object) starts
// the compile in the background (KHR_parallel_shader_compile) and resolves when the programs are ready, so layers
// can keep a new tile or model hidden for those few frames. warm(scene) once the map is up covers everything that
// already exists, hidden things included (animals, wakes, grass, boats).
//
// The scene holds tens of thousands of meshes but few distinct (material, mesh kind) pairs, so one stand-in per pair
// is compiled, in one pass; shadow casters with their own depth material get a stand-in drawn as the shadow pass
// draws them (into a render target: linear colour, no tone mapping).
import * as THREE from 'three';

let ctx = null, target = null;
const SHADOW_SIDE = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
const defaultDepth = new Map();          // stand-ins for three's own depth material, per variant

/** offscreen(): true when the scene is drawn into a render target (post-processing on: linear colour, no tone map). */
export function setWarmContext(renderer, scene, camera, offscreen = () => false) { ctx = { renderer, scene, camera, offscreen }; }

// the depth material the shadow pass will use for material m (as three's WebGLShadowMap getDepthMaterial does)
function shadowDepth(o, m) {
  let d = o.customDepthMaterial;
  const cut = m.alphaTest > 0 && (m.map || m.alphaMap);
  const side = m.shadowSide ?? SHADOW_SIDE[m.side];
  if (!d) {
    const k = `${side}|${cut ? 1 : 0}|${m.wireframe ? 1 : 0}|${m.displacementMap ? 1 : 0}`;
    d = defaultDepth.get(k);
    if (!d) { d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }); defaultDepth.set(k, d); }
  }
  Object.assign(d, { side, alphaMap: m.alphaMap, alphaTest: m.alphaTest, map: m.map, wireframe: m.wireframe,
                     displacementMap: m.displacementMap, displacementScale: m.displacementScale, displacementBias: m.displacementBias });
  return d;
}

function standIn(o, material) {
  let s;
  if (o.isInstancedMesh) {
    s = new THREE.InstancedMesh(o.geometry, material, 1);
    if (o.instanceColor) s.setColorAt(0, new THREE.Color(1, 1, 1));
  } else if (o.isLineSegments) s = new THREE.LineSegments(o.geometry, material);
  else if (o.isLine) s = new THREE.Line(o.geometry, material);
  else if (o.isPoints) s = new THREE.Points(o.geometry, material);
  else s = new THREE.Mesh(o.geometry, material);
  s.receiveShadow = o.receiveShadow;
  return s;
}

export function warm(root) {
  if (!ctx || !root) return Promise.resolve();
  try {
    const r = ctx.renderer, shadows = r.shadowMap.enabled;
    const main = new THREE.Group(), depth = new THREE.Group(), seen = new Set();
    const visit = (o, castOk, ro) => {
      if (o.userData.noShadow) castOk = false;
      if (o.name === 'terrain' || o.name === 'roads3d' || o.name === 'roads') ro = true;   // receive only (shadows.js)
      if (o.isMesh || o.isLine || o.isPoints) {
        const mats = Array.isArray(o.material) ? o.material : [o.material], m0 = mats[0];
        // receiving shadows changes the program: the rule of shadows.js assign(), applied now, not 45 frames later
        if (shadows && castOk && o.isMesh && !o.isLineSegments2 && m0 && !m0.isShaderMaterial && !m0.isLineMaterial) o.receiveShadow = true;
        const kind = `${o.isInstancedMesh ? 'i' : ''}${o.instanceColor ? 'c' : ''}${o.isLine ? 'l' : ''}${o.isPoints ? 'p' : ''}${o.receiveShadow ? 'r' : ''}`
                   + `|${Object.keys(o.geometry?.attributes || {}).join()}`;
        const key = mats.map((m) => m?.uuid).join() + kind;
        if (!seen.has(key)) { seen.add(key); main.add(standIn(o, o.material)); }
        // the shadow pass draws casters with a depth material (their own, as shadows.js assigns it, or three's)
        const bulk = o.isInstancedMesh && o.count > 4000 && !m0?.userData?.depthMaterial;
        if (shadows && castOk && !ro && !bulk && !o.userData.receiveOnly && o.isMesh && m0 && !m0.isShaderMaterial && !o.isLineSegments2) {
          if (!o.customDepthMaterial && m0.userData?.depthMaterial) o.customDepthMaterial = m0.userData.depthMaterial;
          const d = shadowDepth(o, m0);
          const dk = `${d.uuid}|${o.isInstancedMesh ? 'i' : ''}|${d.side}|${d.alphaTest > 0 && d.map ? 1 : 0}`;
          if (!seen.has(dk)) { seen.add(dk); depth.add(standIn(o, d)); }
        }
      }
      for (const ch of o.children) visit(ch, castOk, ro);
    };
    visit(root, true, false);
    const jobs = [], prev = r.getRenderTarget();
    target ||= new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    if (main.children.length) {
      if (ctx.offscreen()) r.setRenderTarget(target);
      jobs.push(r.compileAsync(main, ctx.camera, ctx.scene).catch(() => {}));
      r.setRenderTarget(prev);
    }
    if (depth.children.length) {
      r.setRenderTarget(target);                     // the shadow map is a render target too
      jobs.push(r.compileAsync(depth, ctx.camera, ctx.scene).catch(() => {}));
      r.setRenderTarget(prev);
    }
    return Promise.all(jobs);
  } catch (e) {
    console.warn('Shader warm-up:', e.message);
    return Promise.resolve();
  }
}
