// Planar water reflections near the camera.
//
// When the viewer is low over the delta, the scene is drawn a second time (at reduced resolution) from a camera
// mirrored in the local water level, clipped at that level (oblique near plane) and limited to a few km. The terrain
// water shader projects each water point into that picture (GLOBALS.uReflMatrix) and uses it in place of the sky
// where something was drawn (alpha 1); empty pixels keep the shader's sky + cloud reflection.
// Trees, houses, boats and banks therefore show upside down in rivers and canals. Off in the fast mode.
// Distant level-of-detail layers (userData.noShadow: far houses, tree sprites) are left out of the pass.
import * as THREE from 'three';
import { GLOBALS } from './globals.js';

const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

export class WaterReflection {
  constructor(renderer, scene, { range = 4000, maxHeight = 1500 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.range = range;              // how far the reflection camera sees (scene m)
    this.maxHeight = maxHeight;      // above this height over the water, no reflection pass
    this.scale = 0;
    this.frame = 0;
    this.lastView = new THREE.Matrix4();
    this.lastY = NaN;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.cam = new THREE.PerspectiveCamera();
    this.cam.matrixAutoUpdate = true;
    this.clear = new THREE.Color();
    this.v = new THREE.Vector3();
    this.q = new THREE.Vector4();
    this.plane = new THREE.Vector4();
    this.size = new THREE.Vector2();
    this.dummy = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    this.dummy.needsUpdate = true;
    GLOBALS.uReflMap.value = this.target.texture;
  }

  /** scale of the screen resolution (0 = off). */
  setQuality(scale) { this.scale = scale; if (!scale) GLOBALS.uRefl.value.x = 0; }

  /**
   * @param waterY  scene height of the water surface near the view
   * @param hide    objects to hide during the pass (sky dome, overlays)
   */
  update(camera, waterY, hide = []) {
    const R = GLOBALS.uRefl.value;
    const h = camera.position.y - waterY;
    if (!this.scale || !(h > 0) || h > this.maxHeight) { R.x = 0; this.lastY = NaN; return; }
    // a still view keeps its picture (redrawn every 3rd frame for boats and swaying trees)
    this.frame++;
    if (R.x === 1 && waterY === this.lastY && this.lastView.equals(camera.matrixWorld) && this.frame % 3 !== 0) return;
    this.lastView.copy(camera.matrixWorld);
    this.lastY = waterY;
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    const w = Math.max(64, Math.round(this.size.x * this.scale)), hh = Math.max(64, Math.round(this.size.y * this.scale));
    if (this.target.width !== w || this.target.height !== hh) this.target.setSize(w, hh);

    // mirror the camera in the plane y = waterY
    const cam = this.cam;
    cam.copy(camera, false);
    cam.far = Math.min(camera.far, this.range + h * 2);
    cam.position.set(camera.position.x, 2 * waterY - camera.position.y, camera.position.z);
    const m = camera.matrixWorld.elements;
    const fwd = this.v.set(-m[8], m[9], -m[10]);                     // forward (-z column) with y flipped
    cam.up.set(m[4], -m[5], m[6]);                                    // up (y column) with y flipped
    cam.lookAt(cam.position.x + fwd.x, cam.position.y + fwd.y, cam.position.z + fwd.z);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();

    // oblique near plane = the water plane, so nothing below the water is drawn (Lengyel; as in three's Reflector)
    const off = 0.4;                                                   // just above the water: no fighting with it
    const n = this.v.set(0, 1, 0).transformDirection(cam.matrixWorldInverse);
    const p = new THREE.Vector3(0, waterY + off, 0).applyMatrix4(cam.matrixWorldInverse);
    this.plane.set(n.x, n.y, n.z, -p.dot(n));
    const pm = cam.projectionMatrix.elements;
    const q = this.q.set((Math.sign(this.plane.x) + pm[8]) / pm[0], (Math.sign(this.plane.y) + pm[9]) / pm[5], -1,
                         (1 + pm[10]) / pm[14]);
    this.plane.multiplyScalar(2 / this.plane.dot(q));
    pm[2] = this.plane.x; pm[6] = this.plane.y; pm[10] = this.plane.z + 1; pm[14] = this.plane.w;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

    GLOBALS.uReflMatrix.value.copy(BIAS).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    R.set(0, waterY, this.range, 0);                                  // off while drawing, and no texture feedback loop
    GLOBALS.uReflMap.value = this.dummy;

    const shadowAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    if (!this.bulk || this.frame % 60 === 0) {
      this.bulk = [];
      this.scene.traverse((o) => { if (o.isMesh && o.userData.noShadow) this.bulk.push(o); });
    }
    hide = hide.concat(this.bulk);
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => { o.visible = false; });
    const prevTarget = r.getRenderTarget(), prevAlpha = r.getClearAlpha();
    r.getClearColor(this.clear);
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene, cam);
    r.setRenderTarget(prevTarget);
    r.setClearColor(this.clear, prevAlpha);
    hide.forEach((o, i) => { o.visible = vis[i]; });
    r.shadowMap.autoUpdate = shadowAuto;
    GLOBALS.uReflMap.value = this.target.texture;
    R.x = 1;
  }
}
