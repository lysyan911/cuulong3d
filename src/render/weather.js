// Weather (Claude Code, rendering): clear afternoon (the default), partly cloudy, overcast, rain shower, morning
// mist; and the time of day (sunrise, morning, noon, afternoon = the default, sunset): where the sun is, its colour
// and strength, the sky and haze colours. set('time:sunset') etc. (the menu goes through the same hook).
//
// One set of numbers per weather, eased over ~6 s when it changes: cloud cover and how dark the clouds are (sky and
// cloud shadows, render/atmosphere.js), sun strength and sharpness of its shadows, sky light, haze, colour grade,
// wetness (darker, glossier ground and roofs, puddles: atmosphere.js patchCloudShadow) and rain (streaks around the
// camera here, rings on the water in shaders.js). Heavy rain brings the odd lightning flash. All through
// GLOBALS.uWeather (overcast darkness, rain, flash, wetness) and a few lights / uniforms in the scene.
import * as THREE from 'three';
import { GLOBALS } from './globals.js';
import { skyMaterial, cloudUniforms, MIST, FOG_SUN } from './atmosphere.js';

export const WEATHERS = {
  //          cloud cover, cloud-shadow strength, cloud darkness, rain, wetness, haze x, sun x, grey sky, ground mist,
  //          warm light (low sun through mist)
  clear:    { cover: 0.36, shade: 0.55, dark: 0.0,  rain: 0, wet: 0,    haze: 1.0, sun: 1.0,  grey: 0,    mist: 0, warm: 0 },
  cloudy:   { cover: 0.62, shade: 0.6,  dark: 0.15, rain: 0, wet: 0,    haze: 1.25, sun: 0.92, grey: 0.15, mist: 0, warm: 0 },
  overcast: { cover: 1.05, shade: 0.7,  dark: 0.5,  rain: 0, wet: 0.2,  haze: 1.8, sun: 0.42, grey: 0.65, mist: 0, warm: 0 },
  rain:     { cover: 1.3,  shade: 0.8,  dark: 0.85, rain: 1, wet: 1,    haze: 2.6, sun: 0.22, grey: 0.9,  mist: 0, warm: 0, storm: true },
  // early-morning mist over the delta: a white layer in the fields and orchards, tree tops and roofs above it, dew,
  // soft warm light, thin high cloud; the sun low in the east-south-east, glowing through the mist (~6:30)
  mist:     { cover: 0.2,  shade: 0.5,  dark: 0.0,  rain: 0, wet: 0.25, haze: 1.4, sun: 0.75, grey: 0.0,  mist: 1, warm: 1,
              sunK: 1 },
};
for (const w of Object.values(WEATHERS)) w.sunK ??= 0;   // 1: the weather has its own sun (mist: early morning)
const MIST_SUN = new THREE.Vector3(0.93, 0.17, 0.33).normalize();
const KEYS = Object.keys(WEATHERS.clear).filter((k) => k !== 'storm');

// Time of day (October, ~10.5° N). x east, y up, z south. sun: direction; sunI: strength; light: sun colour;
// horizon / zenith: sky; fog: haze colour; hemi: sky light; warm: colour grade. 'afternoon' is the map's own light.
const TIMES = {
  sunrise: { sun: [0.982, 0.07, 0.173], sunI: 0.45, light: [1.0, 0.62, 0.38], horizon: [1.0, 0.66, 0.5],
             zenith: [0.22, 0.28, 0.5], fog: [0.95, 0.78, 0.7], hemi: 0.5, warm: 1.0 },
  morning: { sun: [0.768, 0.53, 0.358], sunI: 0.95, light: [1.0, 0.9, 0.78], horizon: [0.74, 0.8, 0.88],
             zenith: [0.1, 0.25, 0.58], fog: [0.72, 0.79, 0.88], hemi: 1.0, warm: 0.3 },
  noon:    { sun: [0.0, 0.951, 0.309], sunI: 1.15, light: [1.0, 0.98, 0.94], horizon: [0.7, 0.79, 0.9],
             zenith: [0.06, 0.21, 0.56], fog: [0.7, 0.78, 0.9], hemi: 1.1, warm: 0.0 },
  afternoon: null,                                   // filled from the scene's own light (Weather constructor)
  sunset:  { sun: [-0.982, 0.07, 0.173], sunI: 0.5, light: [1.0, 0.55, 0.3], horizon: [1.0, 0.58, 0.42],
             zenith: [0.16, 0.2, 0.42], fog: [0.92, 0.72, 0.62], hemi: 0.45, warm: 1.2 },
};
const flat = (t) => ({ sx: t.sun[0], sy: t.sun[1], sz: t.sun[2], sunI: t.sunI, hemi: t.hemi, warm: t.warm,
                       ...Object.fromEntries(['light', 'horizon', 'zenith', 'fog'].flatMap((k) => t[k].map((v, i) => [k + i, v]))) });
const GREY_HORIZON = new THREE.Color(0.56, 0.59, 0.62), GREY_ZENITH = new THREE.Color(0.33, 0.36, 0.41);
const GREY_LIGHT = new THREE.Color(0.86, 0.88, 0.9);
const WARM_LIGHT = new THREE.Color(1.0, 0.78, 0.55);         // the low sun through the mist
const WARM_HORIZON = new THREE.Color(0.98, 0.76, 0.62), WARM_ZENITH = new THREE.Color(0.32, 0.36, 0.55);   // dawn sky
const WARM_FOG = new THREE.Color(0.9, 0.8, 0.74);

// rain: streaks in a box that travels with the camera, falling in the vertex shader (no per-frame CPU work)
function rainStreaks(count, box) {
  const pos = new Float32Array(count * 6), end = new Float32Array(count * 2), seed = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = (Math.random() - 0.5) * 2 * box, y = (Math.random() - 0.5) * 2 * box, z = (Math.random() - 0.5) * 2 * box, s = Math.random();
    pos.set([x, y, z, x, y, z], i * 6);
    end[i * 2 + 1] = 1;
    seed[i * 2] = seed[i * 2 + 1] = s;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { uTime: { value: 0 }, uRain: { value: 0 }, uBox: { value: box }, uCam: { value: new THREE.Vector3() }, uLight: { value: 1 } },
    vertexShader: /* glsl */ `attribute float aEnd, aSeed; uniform float uTime, uBox; uniform vec3 uCam; varying float vA;
      void main() {
        vec3 p = position;
        float speed = 8.5 + 2.0 * aSeed;
        p.y = mod(p.y - uTime * speed - uCam.y, 2.0 * uBox) - uBox;          // falls through the box, wraps round
        p.x = mod(p.x - uCam.x + uTime * 1.6, 2.0 * uBox) - uBox;            // light wind from the WSW
        p.z = mod(p.z - uCam.z - uTime * 0.7, 2.0 * uBox) - uBox;
        vec3 w = uCam + p;
        w += aEnd * vec3(0.10, 0.62 + 0.25 * aSeed, -0.045);                 // the streak (motion blur of the drop)
        vA = (1.0 - smoothstep(0.5 * uBox, uBox, length(p))) * (0.55 + 0.45 * aSeed);
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */ `uniform float uRain, uLight; varying float vA;
      void main() { gl_FragColor = vec4(vec3(0.74, 0.78, 0.82) * uLight, 0.5 * uRain * vA); }`,
  });
  const lines = new THREE.LineSegments(g, m);
  lines.frustumCulled = false;
  lines.renderOrder = 5;
  Object.assign(lines.userData, { noShadow: true, noReflect: true });
  return lines;
}

export class Weather {
  constructor({ renderer, scene, sun, shadows, pipeline, mobile = false }) {
    this.renderer = renderer; this.scene = scene; this.sun = sun; this.shadows = shadows; this.pipeline = pipeline;
    scene.traverse((o) => { if (o.isHemisphereLight) this.hemi = o; });
    this.base = { sun: sun.intensity, sunColor: sun.color.clone(), hemi: this.hemi?.intensity ?? 0.42,
                  hemiSky: this.hemi?.color.clone(), env: scene.environmentIntensity ?? 1,
                  horizon: GLOBALS.uHorizon.value.clone(), zenith: GLOBALS.uZenith.value.clone(), cover: GLOBALS.uCloud.value.x,
                  shade: GLOBALS.uCloud.value.z };
    this.now = { ...WEATHERS.clear };
    this.target = WEATHERS.clear;
    this.name = 'clear';
    TIMES.afternoon ??= { sun: GLOBALS.uSunDir.value.toArray(), sunI: 1, light: sun.color.toArray(), horizon: this.base.horizon.toArray(),
                          zenith: this.base.zenith.toArray(), fog: this.base.horizon.toArray(), hemi: 1, warm: 0 };
    for (const k of Object.keys(TIMES)) if (TIMES[k] && !TIMES[k].flat) TIMES[k].flat = flat(TIMES[k]);
    this.day = { ...TIMES.afternoon.flat };
    this.dayTarget = TIMES.afternoon.flat;
    this.timeName = 'afternoon';
    this.rain = rainStreaks(mobile ? 5000 : 16000, mobile ? 18 : 24);
    this.rain.visible = false;
    scene.add(this.rain);
    this.flash = 0; this.nextFlash = 8; this.flashT = -1; this.time = 0;
    this.envClear = scene.environment;
  }

  // the sky light for reflections under a grey sky (wet streets would otherwise mirror the clear blue one)
  greyEnvironment() {
    if (this.envGrey || !this.renderer) return this.envGrey;
    const pmrem = new THREE.PMREMGenerator(this.renderer), s = new THREE.Scene();
    const m = skyMaterial(cloudUniforms(), { horizon: GREY_HORIZON.clone().multiplyScalar(0.9), zenith: GREY_ZENITH.clone() });
    m.uniforms.uClouds.value = 0;
    s.add(new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), m));
    this.envGrey = pmrem.fromScene(s, 0, 1, 2000).texture;
    pmrem.dispose(); m.dispose();
    return this.envGrey;
  }

  /** 'clear' | 'cloudy' | 'overcast' | 'rain' | 'mist' | 'auto' (a delta afternoon: mostly fair, now and then a shower). */
  set(name) {
    if (name.startsWith('time:')) {
      const t = TIMES[name.slice(5)];
      if (t) { this.dayTarget = t.flat; this.timeName = name.slice(5); }
      return;
    }
    if (name === 'auto') { this.name = 'auto'; this.auto = { step: -1, left: 0 }; return; }
    if (!WEATHERS[name]) return;
    this.name = name;
    this.auto = null;
    this.target = WEATHERS[name];
  }

  // auto: clear / partly cloudy for a few minutes, sometimes clouds build up into a short shower, then it clears
  autoStep(dt) {
    const A = this.auto;
    A.left -= dt;
    if (A.left > 0) return;
    const r = Math.random();
    const plan = A.step === -1 ? ['clear', 90 + r * 120]
      : this.target === WEATHERS.clear ? (r < 0.6 ? ['cloudy', 60 + r * 120] : ['clear', 120 + r * 120])
      : this.target === WEATHERS.cloudy ? (r < 0.35 ? ['overcast', 40 + r * 40] : ['clear', 120 + r * 180])
      : this.target === WEATHERS.overcast ? (r < 0.75 ? ['rain', 60 + r * 90] : ['cloudy', 90])
      : ['cloudy', 90 + r * 90];                          // after the shower
    A.step++;
    this.target = WEATHERS[plan[0]];
    A.left = plan[1];
  }

  /** Call every frame after the scene's fog has been set for the frame (dt in s). */
  update(dt, camera) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    if (this.auto) this.autoStep(dt);
    const k = 1 - Math.exp(-dt / 2.0);                // ease towards the target (~6 s to settle)
    const dry = 1 - Math.exp(-dt / 20.0);             // after the rain the ground stays wet for a while (~1 min)
    for (const key of KEYS) {
      const rate = key === 'wet' && this.target.wet < this.now.wet ? dry : k;
      this.now[key] += (this.target[key] - this.now[key]) * rate;
    }
    for (const key in this.dayTarget) this.day[key] += (this.dayTarget[key] - this.day[key]) * k;
    const w = this.now, B = this.base, D = this.day;
    const c3 = (p) => new THREE.Color(D[p + '0'], D[p + '1'], D[p + '2']);
    // lightning in heavy rain: two quick pulses every 6-20 s
    if (this.target.storm && w.rain > 0.7) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) { this.flashT = 0; this.nextFlash = 6 + Math.random() * 14; }
    }
    if (this.flashT >= 0) {
      this.flashT += dt;
      const t = this.flashT;
      this.flash = Math.max(0, 1 - Math.abs(t - 0.05) / 0.05) * 0.9 + Math.max(0, 1 - Math.abs(t - 0.22) / 0.08) * 0.6;
      if (t > 0.4) { this.flashT = -1; this.flash = 0; }
    }
    GLOBALS.uCloud.value.x = w.cover;
    GLOBALS.uCloud.value.z = w.shade;
    GLOBALS.uWeather.value.set(w.dark, w.rain, this.flash, w.wet);
    // the time of day sets the sky, haze and sunlight; the weather greys or warms them (mist: its own dawn)
    GLOBALS.uHorizon.value.copy(c3('horizon')).lerp(GREY_HORIZON, w.grey).lerp(WARM_HORIZON, 0.55 * w.warm);
    GLOBALS.uZenith.value.copy(c3('zenith')).lerp(GREY_ZENITH, w.grey).lerp(WARM_ZENITH, 0.5 * w.warm);
    if (this.scene.fog?.isFogExp2) {
      this.scene.fog.density *= w.haze;
      this.scene.fog.color.multiply(c3('fog')).multiply(new THREE.Color(1 / B.horizon.r, 1 / B.horizon.g, 1 / B.horizon.b));
    }
    this.scene.fog?.color.lerp(GREY_HORIZON, w.grey * 0.6).lerp(WARM_FOG, 0.55 * w.warm);
    const lowSun = 1 - w.sunK;                        // (mist brings its own sun, low and soft)
    this.sun.intensity = B.sun * w.sun * (D.sunI * lowSun + w.sunK);
    this.sun.color.copy(c3('light')).lerp(GREY_LIGHT, w.grey).lerp(WARM_LIGHT, 0.6 * w.warm);
    MIST.x = 0.013 * w.mist;                          // per m at the ground: ~250 m visibility down in it
    // the sun's direction (eased like the rest): sky, clouds, shadows (shadows.js reads it), glints and the haze glow
    const sd = GLOBALS.uSunDir.value.set(D.sx, D.sy, D.sz).normalize().lerp(MIST_SUN, w.sunK).normalize();
    Object.assign(FOG_SUN, { x: sd.x, y: sd.y, z: sd.z });
    if (this.hemi) {
      this.hemi.intensity = B.hemi * (1 + 1.3 * w.grey) * (D.hemi * lowSun + w.sunK) + this.flash * 2.5;
      this.hemi.color.copy(B.hemiSky).lerp(GREY_LIGHT, w.grey);
    }
    this.scene.environmentIntensity = B.env * (1 + 0.7 * w.grey) * (D.hemi * lowSun + w.sunK);
    const env = w.grey > 0.4 ? this.greyEnvironment() || this.envClear : this.envClear;
    if (this.scene.environment !== env) this.scene.environment = env;
    if (this.shadows) this.shadows.strength = 1 - 0.85 * w.grey;
    // colour grade: greyer, cooler under cloud
    const passes = this.pipeline?.composer?.passes || [];
    for (const p of passes) if (p.uniforms?.uRainVeil) {
      p.uniforms.uRainVeil.value = w.rain * (camera.position.y < 2500 ? 1 : 0);
      p.uniforms.uTime.value = this.time;
    }
    for (const p of passes) if (p.uniforms?.uSat) {
      p.userData ||= {};
      p.userData.base ||= { sat: p.uniforms.uSat.value, warm: p.uniforms.uWarm.value };
      p.uniforms.uSat.value = p.userData.base.sat * (1 - 0.18 * w.grey);
      p.uniforms.uWarm.value = p.userData.base.warm * (1 - 0.85 * w.grey) * (1 + 0.8 * Math.max(w.warm, D.warm));
    }
    // the far road lines (world.js, unlit map-style lines) dim with the daylight, or they glow at dusk
    const daylight = (D.hemi * lowSun + w.sunK) * (1 - 0.35 * w.grey);
    this.lineBase ||= new WeakMap();
    if (Math.abs(daylight - (this.lineLight ?? 1)) > 0.01 || (daylight < 0.99 && (this.lineCheck = (this.lineCheck || 0) + dt) > 2)) {
      this.lineLight = daylight; this.lineCheck = 0;                // (lines of groups loaded later are caught too)
      this.scene.getObjectByName('roads')?.traverse((o) => {
        const m = o.material;
        if (!m?.isLineMaterial) return;
        if (!this.lineBase.has(m)) this.lineBase.set(m, m.color.clone());
        m.color.copy(this.lineBase.get(m)).multiplyScalar(Math.min(1, 0.12 + 0.88 * Math.pow(daylight, 1.6)));
      });
    }
    // rain streaks around the camera (none from high above the clouds)
    const R = this.rain;
    R.visible = w.rain > 0.02 && camera.position.y < 2500;
    if (R.visible) {
      const u = R.material.uniforms;
      u.uTime.value = this.time; u.uRain.value = w.rain; u.uCam.value.copy(camera.position);
      u.uLight.value = 0.55 + 0.45 * (1 - w.grey) + this.flash;
    }
  }
}
