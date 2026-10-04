// Occlusion culling: blocks of houses behind the street front, whole far house tiles behind nearer buildings or hills,
// street-detail cells round the corner are not drawn.
// Layers mark such objects with userData.occBox (a world-space THREE.Box3 that surely contains them). After each frame
// their boxes are drawn invisibly against that frame's depth buffer inside WebGL2 occlusion queries. An object whose box
// showed no pixel moves to HIDDEN_LAYER: the camera sees layer 0 only, while the sun's shadow camera and the water mirror
// see both, so its shadows and reflections stay. Results arrive a frame or two later; anything without a fresh result,
// or after a jump of the camera, is drawn. Nested objects with their own box keep their own state.
// Copies of instanced models (hero houses, landmarks: OCC_SOURCES) are tested one by one; those well out of view are
// dropped too (three.js draws every copy of an InstancedMesh). The water reflection's and sun's cameras see HIDDEN_LAYER.
import * as THREE from 'three';

export const HIDDEN_LAYER = 1;
// per-instance items of other layers (hero houses, landmarks): { version, items: [{ box, shown(), setHidden(h) }] }
export const OCC_SOURCES = [];
const BUDGET = 700;                  // queries per frame
const FRESH = 3;                     // frames a result stays valid

const VS = `#version 300 es
in vec3 aPos;
uniform mat4 uMVP;
out float vD;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); vD = 1.0 + gl_Position.w; }`;
// the scene uses a logarithmic depth buffer: write depth the same way three.js does
const FS = `#version 300 es
precision highp float;
in float vD;
uniform float uFC;
out vec4 oColor;
void main() { gl_FragDepth = log2(vD) * uFC * 0.5; oColor = vec4(0.0); }`;

export class OcclusionCuller {
  /** getTarget(): the render target holding the frame's depth (null: the canvas; undefined: none, culling off). */
  constructor(renderer, scene, camera, getTarget) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.getTarget = getTarget;
    this.items = new Map();
    this.frame = 0;
    this.jumpFrame = 0;
    this.enabled = true;
    this.stats = { items: 0, tested: 0, hidden: 0 };
    this.lastPos = new THREE.Vector3(1e9, 0, 0);
    this.lastDir = new THREE.Vector3();
    this.vp = new THREE.Matrix4();
    this.m = new THREE.Matrix4();
    this.frustum = new THREE.Frustum();
    this.wide = new THREE.Box3();
    this.c = new THREE.Vector3();
    this.s = new THREE.Vector3();
    this.init();
  }

  init() {
    const gl = this.gl = this.renderer.getContext();
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const p = this.prog = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn('Occlusion culling off:', gl.getProgramInfoLog(p)); this.enabled = false; return; }
    this.uMVP = gl.getUniformLocation(p, 'uMVP');
    this.uFC = gl.getUniformLocation(p, 'uFC');
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-.5, -.5, -.5, .5, -.5, -.5, .5, .5, -.5, -.5, .5, -.5,
                                                     -.5, -.5, .5, .5, -.5, .5, .5, .5, .5, -.5, .5, .5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
                                                            3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2]), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.renderer.resetState();
  }

  /** Pick up objects with userData.occBox (new tiles, blocks); forget the ones no longer in the scene. */
  rescan() {
    const seen = new Set();
    this.scene.traverse((o) => {
      if (!o.userData.occBox) return;
      seen.add(o);
      if (!this.items.has(o)) this.items.set(o, { obj: o, box: o.userData.occBox, query: null, result: true, at: -99, hidden: false });
    });
    for (const src of OCC_SOURCES) for (const v of src.items) {
      seen.add(v);
      if (!this.items.has(v)) this.items.set(v, { virt: v, box: v.box, query: null, result: true, at: -99, hidden: false });
    }
    this.versions = OCC_SOURCES.map((src) => src.version);
    for (const [o, it] of this.items) if (!seen.has(o)) { if (it.query) this.gl.deleteQuery(it.query); this.items.delete(o); }
    this.stats.items = this.items.size;
  }

  setHidden(it, hidden) {
    it.hidden = hidden;
    if (it.virt) { it.virt.setHidden(hidden); return; }
    const mask = hidden ? 1 << HIDDEN_LAYER : 1;
    const walk = (o) => {
      if (o !== it.obj && o.userData.occBox) return;       // has its own state
      o.layers.mask = mask;
      for (const c of o.children) walk(c);
    };
    walk(it.obj);
  }

  /** Before rendering: hide what the last results say is hidden. */
  apply() {
    this.frame++;
    if (this.frame % 30 === 1 || OCC_SOURCES.some((src, k) => src.version !== this.versions?.[k])) this.rescan();
    const cam = this.camera, dir = this.c;
    cam.getWorldDirection(dir);
    const pm = cam.projectionMatrix.elements;                // (zoom, resize: the view's shape changed)
    const jump = cam.position.distanceTo(this.lastPos) > 40 || dir.dot(this.lastDir) < 0.94 || pm[0] !== this.lastP0 || pm[5] !== this.lastP5;
    this.lastPos.copy(cam.position);
    this.lastDir.copy(dir);
    this.lastP0 = pm[0]; this.lastP5 = pm[5];
    let hidden = 0;
    for (const it of this.items.values()) {
      if (jump) { it.at = -99; this.jumpFrame = this.frame; }   // results from another view: draw everything once
      const h = this.enabled && !it.result && this.frame - it.at <= FRESH;
      if (h !== it.hidden) this.setHidden(it, h);
      if (h) hidden++;
    }
    this.stats.hidden = hidden;
  }

  /** After rendering: read finished queries and test the boxes against this frame's depth. */
  query() {
    if (!this.enabled) return;
    const target = this.getTarget();
    if (target === undefined) return;
    const gl = this.gl, r = this.renderer, cam = this.camera;
    r.setRenderTarget(target);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.colorMask(false, false, false, false);
    gl.depthMask(false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.uniform1f(this.uFC, 2.0 / (Math.log(cam.far + 1.0) / Math.LN2));
    this.vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.vp);
    const p = cam.position;
    let n = 0;
    for (const it of this.items.values()) {
      if (it.query && it.pending) {
        if (!gl.getQueryParameter(it.query, gl.QUERY_RESULT_AVAILABLE)) continue;
        it.result = gl.getQueryParameter(it.query, gl.QUERY_RESULT) > 0 || it.issued < this.jumpFrame;
        it.at = it.issued;
        it.pending = false;
      }
      if (it.virt ? !it.virt.shown() : !this.shown(it.obj)) continue;
      const b = it.box;
      if (it.virt) {                                       // copies of instanced models are not frustum-culled by three.js:
        this.wide.copy(b).expandByScalar(20);              // drop the ones well out of view (keeping nearby shadows)
        if (!this.frustum.intersectsBox(this.wide)) { it.result = false; it.at = this.frame; continue; }
      }
      if (!this.frustum.intersectsBox(b)) continue;
      if (p.x > b.min.x - 3 && p.x < b.max.x + 3 && p.y > b.min.y - 3 && p.y < b.max.y + 3 && p.z > b.min.z - 3 && p.z < b.max.z + 3) {
        it.result = true; it.at = this.frame; continue;      // the camera is inside: visible
      }
      if (n >= BUDGET) continue;
      b.getCenter(this.c); b.getSize(this.s);
      this.m.makeScale(this.s.x, this.s.y, this.s.z).setPosition(this.c).premultiply(this.vp);
      gl.uniformMatrix4fv(this.uMVP, false, this.m.elements);
      if (!it.query) it.query = gl.createQuery();
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, it.query);
      gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      it.pending = true;
      it.issued = this.frame;
      n++;
    }
    this.stats.tested = n;
    gl.bindVertexArray(null);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    r.resetState();
    r.setRenderTarget(null);
  }

  // in the scene and switched on (by its layer's own distance rules)
  shown(o) {
    for (; o; o = o.parent) { if (!o.visible) return false; if (o === this.scene) return true; }
    return false;
  }
}
