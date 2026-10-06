// Post-processing and quality modes.
//
//   fast       straight to the screen (phones): no shadows, no post-processing
//   good       sun shadows (2048), ambient occlusion at half resolution (N8AO), water reflections at 0.4x, and one
//              final pass doing filmic (ACES) tone mapping + colour grading + vignette + FXAA (desktop default)
//   cinematic  sharper shadows (4096), full-resolution AO, 0.75x reflections, soft bloom on the brightest light,
//              SMAA anti-aliasing, higher pixel ratio: for close-ups and screenshots
// If the AO library can't load, the pipeline keeps everything else.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

export const QUALITY_MODES = {
  fast: { post: false, shadowMap: 0, ao: null, pixelRatio: 1, reflection: 0 },
  good: { post: true, shadowMap: 2048, reflection: 0.4, ao: { halfRes: true, aoSamples: 8, denoiseSamples: 4 }, pixelRatio: 1.25,
          bloom: false, aa: 'fxaa' },
  cinematic: { post: true, shadowMap: 4096, reflection: 0.75, ao: { halfRes: false, aoSamples: 16, denoiseSamples: 8 }, pixelRatio: 2,
               bloom: true, aa: 'smaa' },
};

const VEIL = /* glsl */ `
    // rain (render/weather.js): faint falling streaks over the picture, three layers for depth
    float rainVeil(vec2 uv, float t) {
      float s = 0.0;
      for (int i = 0; i < 3; i++) {
        float fi = float(i), sc = 1.0 + fi * 0.75;
        vec2 q = vec2(uv.x * 150.0 * sc + uv.y * 16.0 * sc, uv.y * 2.6 * sc);
        float col = floor(q.x), h = fract(sin(col * 12.9898 + fi * 7.13) * 43758.5453);
        float y = fract(q.y + t * (1.5 + h) * (1.0 + fi * 0.45) + h * 7.0);
        float on = step(0.5, fract(h * 13.7));
        float w = 1.0 - abs(fract(q.x) - 0.5) * 2.0;
        s += on * smoothstep(0.0, 0.04, y) * (1.0 - smoothstep(0.04, 0.22, y)) * pow(w, 8.0) * (0.55 - fi * 0.14);
      }
      return s;
    }`;

// colour grading in display space: gentle S-curve, saturation, warm highlights / cool shadows, vignette
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uSat: { value: 1.2 }, uWarm: { value: 1.5 }, uVignette: { value: 0.32 },
              uContrast: { value: 0.26 }, uRainVeil: { value: 0 }, uTime: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `uniform sampler2D tDiffuse; uniform float uSat, uWarm, uVignette, uContrast, uRainVeil, uTime; varying vec2 vUv;
    ${VEIL}
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      c += (vec3(0.028, 0.012, -0.018) * smoothstep(0.45, 1.0, l) + vec3(-0.01, 0.0, 0.018) * (1.0 - smoothstep(0.0, 0.35, l))) * uWarm;
      vec2 d = vUv - 0.5;
      c *= 1.0 - uVignette * dot(d, d) * 1.5;
      if (uRainVeil > 0.001) c += vec3(0.8, 0.83, 0.86) * rainVeil(vUv, uTime) * 0.11 * uRainVeil;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

// one pass instead of output + grade + anti-aliasing: ACES + sRGB per tap, FXAA on the display image, then the grade
const FinalShader = {
  uniforms: { tDiffuse: { value: null }, uPx: { value: new THREE.Vector2() }, toneMappingExposure: { value: 1 },
              uSat: GradeShader.uniforms.uSat, uWarm: GradeShader.uniforms.uWarm, uVignette: GradeShader.uniforms.uVignette,
              uContrast: GradeShader.uniforms.uContrast, uRainVeil: { value: 0 }, uTime: { value: 0 } },
  vertexShader: GradeShader.vertexShader,
  fragmentShader: /* glsl */ `uniform sampler2D tDiffuse; uniform vec2 uPx; uniform float uSat, uWarm, uVignette, uContrast, uRainVeil, uTime;
    varying vec2 vUv;
    ${VEIL}   // (three adds the tone mapping + colour space functions to every ShaderMaterial)
    vec3 tap(vec2 uv) { return sRGBTransferOETF(vec4(ACESFilmicToneMapping(texture2D(tDiffuse, uv).rgb), 1.0)).rgb; }
    void main() {
      const vec3 L = vec3(0.299, 0.587, 0.114);
      vec3 rgbM = tap(vUv);
      vec3 nw = tap(vUv + vec2(-1.0, -1.0) * uPx), ne = tap(vUv + vec2(1.0, -1.0) * uPx);
      vec3 sw = tap(vUv + vec2(-1.0, 1.0) * uPx), se = tap(vUv + vec2(1.0, 1.0) * uPx);
      float lM = dot(rgbM, L), lNW = dot(nw, L), lNE = dot(ne, L), lSW = dot(sw, L), lSE = dot(se, L);
      float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
      vec3 c = rgbM;
      if (lMax - lMin > max(0.0312, lMax * 0.125)) {
        vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
        float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
        dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), vec2(-8.0), vec2(8.0)) * uPx;
        vec3 a = 0.5 * (tap(vUv - dir / 6.0) + tap(vUv + dir / 6.0));
        vec3 b = a * 0.5 + 0.25 * (tap(vUv - dir * 0.5) + tap(vUv + dir * 0.5));
        float lB = dot(b, L);
        c = (lB < lMin || lB > lMax) ? a : b;
      }
      c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      c += (vec3(0.028, 0.012, -0.018) * smoothstep(0.45, 1.0, l) + vec3(-0.01, 0.0, 0.018) * (1.0 - smoothstep(0.0, 0.35, l))) * uWarm;
      vec2 d = vUv - 0.5;
      c *= 1.0 - uVignette * dot(d, d) * 1.5;
      if (uRainVeil > 0.001) c += vec3(0.8, 0.83, 0.86) * rainVeil(vUv, uTime) * 0.11 * uRainVeil;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

// Dynamic resolution: the GPU time of the picture (timer query around render()) steers a scale on the pixel ratio.
// Heavy views (village streets, forests) draw fewer pixels, down to DYN_MIN, light ones go back up; steps of 0.1, at
// most once a second, so it never flickers. Cinematic mode (screenshots) always draws full resolution. Without the timer extension a slow frame rate lowers it (and it tries
// going back up now and then).
const DYN_MIN = 0.7;
const DYN_GPU = [8, 13];          // ms of GPU time for the picture: below -> finer, above -> coarser

export class RenderPipeline {
  constructor(renderer, scene, camera, shadows, { mobile = false, reflection = null } = {}) {
    this.dyn = { scale: 1, ext: renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2'), q: null, pending: [],
                 ms: [], last: performance.now(), changed: performance.now(), cap: null };
    this.reflection = reflection;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.shadows = shadows;
    this.mobile = mobile;
    this.mode = null;
    this.composer = null;
    this.size = new THREE.Vector2(innerWidth, innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;     // filmic contrast; AgX looked washed out here
    renderer.toneMappingExposure = 0.95;
  }

  async loadAO() {
    if (this.AOPass !== undefined) return this.AOPass;
    try { this.AOPass = (await import('n8ao')).N8AOPass; } catch (e) { console.warn('Ambient occlusion unavailable:', e.message); this.AOPass = null; }
    return this.AOPass;
  }

  async setMode(name) {
    const q = QUALITY_MODES[name] || QUALITY_MODES.good;
    this.mode = name;
    this.shadows.setQuality(q.shadowMap);
    if (this.reflection) this.reflection.setQuality(q.reflection);
    this.pixelRatio = Math.min(devicePixelRatio, q.pixelRatio);
    if (this.composer) { this.composer.dispose(); this.composer = null; }
    if (!q.post) return;
    const AOPass = q.ao ? await this.loadAO() : null;
    if (this.mode !== name) return;                       // switched again while loading
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: AOPass ? 0 : 4 });
    const composer = new EffectComposer(this.renderer, target);
    if (AOPass) {
      const ao = new AOPass(this.scene, this.camera, this.size.x, this.size.y);
      Object.assign(ao.configuration, { aoRadius: 3.0, distanceFalloff: 0.8, intensity: 3.2, gammaCorrection: false,
                                        denoiseRadius: 8, ...q.ao });
      composer.addPass(ao);
      this.ao = ao;
    } else {
      composer.addPass(new RenderPass(this.scene, this.camera));
      this.ao = null;
    }
    if (q.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(this.size.x / 2, this.size.y / 2), 0.16, 0.55, 0.92));
    this.final = null;
    if (q.aa === 'fxaa') {
      this.final = new ShaderPass(FinalShader);
      composer.addPass(this.final);
    } else {
      composer.addPass(new OutputPass());
      composer.addPass(new ShaderPass(GradeShader));
      if (AOPass) composer.addPass(new SMAAPass(this.size.x, this.size.y));
    }
    this.composer = composer;
    this.applySize();
  }

  setSize(w, h) { this.size.set(w, h); this.applySize(); }

  applySize() {
    if (this.renderer.getPixelRatio() !== this.pixelRatio) this.renderer.setPixelRatio(this.pixelRatio);
    if (this.composer) {
      this.composer.setPixelRatio(this.pixelRatio);
      this.composer.setSize(this.size.x, this.size.y);
    }
    this.updateFinal();
  }

  updateFinal() {
    if (!this.final) return;
    const pr = this.renderer.getPixelRatio();
    this.final.uniforms.uPx.value.set(1 / Math.max(1, Math.round(this.size.x * pr)), 1 / Math.max(1, Math.round(this.size.y * pr)));
    this.final.uniforms.toneMappingExposure.value = this.renderer.toneMappingExposure;
  }

  /** Temporarily lower the pixel ratio (e.g. dense forest views); restores on the next call with null. */
  limitPixelRatio(max) {
    this.dyn.cap = max;
    const want = (max ? Math.min(this.pixelRatio, max) : this.pixelRatio) * this.dyn.scale;
    if (this.renderer.getPixelRatio() !== want) {
      this.renderer.setPixelRatio(want);
      if (this.composer) { this.composer.setPixelRatio(want); this.composer.setSize(this.size.x, this.size.y); }
      this.updateFinal();
    }
  }

  /** Render target holding the frame's scene depth (null: the canvas; undefined: not available). */
  depthTarget() {
    if (!this.composer) return null;
    return this.ao ? this.ao.beautyRenderTarget : undefined;
  }

  render() {
    const D = this.dyn, gl = this.renderer.getContext();
    const timing = D.ext && !D.q && D.pending.length < 3;
    if (timing) { D.q = gl.createQuery(); gl.beginQuery(D.ext.TIME_ELAPSED_EXT, D.q); }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    if (timing) { gl.endQuery(D.ext.TIME_ELAPSED_EXT); D.pending.push(D.q); D.q = null; }
    this.adapt();
  }

  // dynamic resolution (see DYN_MIN): read finished timer queries, adjust the scale once a second
  adapt() {
    const D = this.dyn, gl = this.renderer.getContext(), now = performance.now();
    if (D.ext) {
      while (D.pending.length && gl.getQueryParameter(D.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = D.pending.shift();
        if (!gl.getParameter(D.ext.GPU_DISJOINT_EXT)) D.ms.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
    } else {
      const dt = now - D.last;
      if (dt < 100) D.ms.push(dt);                    // (a hidden tab or a long stall says nothing about the GPU)
    }
    D.last = now;
    if (this.mode === 'cinematic') {
      if (D.scale !== 1) { D.scale = 1; this.limitPixelRatio(D.cap); }
      D.ms = [];
      return;
    }
    if (now - D.changed < (D.ext ? 1000 : 4000) || D.ms.length < 20) return;
    const sorted = D.ms.sort((a, b) => a - b), med = sorted[sorted.length >> 1];
    D.ms = [];
    let k = D.scale;
    if (D.ext) k = med > DYN_GPU[1] ? k - 0.1 : med < DYN_GPU[0] ? k + 0.1 : k;
    else k = med > 21 ? k - 0.1 : med < 17.5 && now - D.changed > 15000 ? k + 0.1 : k;   // 60 fps for 15 s: try finer
    k = Math.round(Math.min(1, Math.max(DYN_MIN, k)) * 10) / 10;
    if (k !== D.scale) { D.scale = k; D.changed = now; this.limitPixelRatio(D.cap); }
  }
}
