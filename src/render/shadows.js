// Sun shadows near the camera.
//
// One shadow map follows the point the camera looks at; its size grows with the viewing distance (sharp ~0.3 m
// texels close up, softer further out) and the shadows fade away above ~5 km, where they would be sub-pixel. The map
// is snapped to whole texels, so shadows don't crawl while the camera moves. The map is only redrawn when that square
// moves (or every 4th frame for animated casters), so a still view costs little.
// assign() walks the scene now and then and decides who casts / receives: layers that place their instances in the
// vertex shader (houses, trees) provide material.userData.depthMaterial so their shadows match what is drawn.
import * as THREE from 'three';

const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

export class SunShadows {
  constructor(renderer, sun, sunDir) {
    this.renderer = renderer;
    this.sun = sun;
    this.sunDir = sunDir;
    this.enabled = false;
    this.depthCache = new WeakMap();
    sun.shadow.camera.near = 50;
    sun.shadow.camera.far = 20000;
    sun.shadow.bias = -0.0003;
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.frame = 0;
    this.last = new THREE.Vector4(NaN, 0, 0, 0);    // centre + size of the last rendered shadow map
  }

  /** mapSize 0 = off. Turning shadows on/off recompiles materials once. */
  setQuality(mapSize) {
    const on = mapSize > 0;
    if (on !== this.enabled) {
      this.renderer.shadowMap.enabled = on;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.sun.castShadow = on;
      this.enabled = on;
      this.needsAssign = true;
    }
    if (on && this.sun.shadow.mapSize.x !== mapSize) {
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
  }

  update(camera, target, scene) {
    if (!this.enabled) return;
    if (this.needsAssign || ++this.frame % 45 === 0) { this.assign(scene); this.needsAssign = false; }
    const d = camera.position.distanceTo(target);
    const k = 1 - smooth(2500, 5000, d);
    this.sun.shadow.intensity = 0.9 * k;
    this.sun.shadow.autoUpdate = false;
    if (k <= 0) return;
    const S = Math.min(Math.max(d * 0.7, 140), 2600);           // half size of the shadowed square (m)
    const cam = this.sun.shadow.camera;
    cam.left = -S; cam.right = S; cam.top = S; cam.bottom = -S;
    // snap the centre to whole texels in the light's view plane
    const texel = (2 * S) / this.sun.shadow.mapSize.x;
    const f = this.sunDir;
    this.right.set(0, 1, 0).cross(f).normalize();
    this.up.copy(f).cross(this.right).normalize();
    const c = target.clone();
    const a = c.dot(this.right), b = c.dot(this.up);
    c.addScaledVector(this.right, Math.round(a / texel) * texel - a).addScaledVector(this.up, Math.round(b / texel) * texel - b);
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(f, 9000);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.sun.shadow.normalBias = texel * 0.9;
    cam.updateProjectionMatrix();
    // redraw the map when the shadowed square moves or resizes; otherwise only every 4th frame (swaying trees, boats)
    const moved = c.x !== this.last.x || c.y !== this.last.y || c.z !== this.last.z || S !== this.last.w;
    if (moved || this.frame % 4 === 0) this.sun.shadow.needsUpdate = true;
    this.last.set(c.x, c.y, c.z, S);
  }

  depthFor(material) {
    if (material.userData.depthMaterial) return material.userData.depthMaterial;
    if (!(material.alphaTest > 0 && material.map)) return null;
    let d = this.depthCache.get(material);
    if (!d) {
      d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: material.map,
                                        alphaTest: material.alphaTest, side: material.side });
      this.depthCache.set(material, d);
    }
    return d;
  }

  assign(scene) {
    const visit = (o, receiveOnly) => {
      if (o.userData.noShadow) return;
      const ro = receiveOnly || o.name === 'terrain' || o.name === 'roads3d' || o.name === 'roads';
      if (o.isMesh && !o.isLineSegments2) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const m = mats[0];
        if (m && !m.isShaderMaterial && !m.isLineMaterial) {
          o.receiveShadow = true;
          // huge instance sets without a matching depth material (e.g. distant forest layers that hide their
          // near trees in their own shader) would be drawn whole into the shadow map: too slow, and doubled shadows
          const bulk = o.isInstancedMesh && o.count > 4000 && !m.userData.depthMaterial;
          o.castShadow = !ro && !bulk && !o.userData.receiveOnly && !(o.geometry && o.geometry.type === 'PlaneGeometry');
          if (o.castShadow) {
            const dm = this.depthFor(m);
            if (dm) o.customDepthMaterial = dm;
          }
        }
      }
      for (const ch of o.children) visit(ch, ro);
    };
    visit(scene, false);
  }
}
