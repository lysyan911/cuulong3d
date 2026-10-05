// Weather (Claude Code, rendering): clear afternoon (the default), partly cloudy, overcast, rain shower.
//
// One set of numbers per weather, eased over ~6 s when it changes: cloud cover and how dark the clouds are (sky and
// cloud shadows, render/atmosphere.js), sun strength and sharpness of its shadows, sky light, haze, colour grade,
// wetness (darker, glossier ground and roofs, puddles: atmosphere.js patchCloudShadow) and rain (streaks around the
// camera here, rings on the water in shaders.js). Heavy rain brings the odd lightning flash. All through
// GLOBALS.uWeather (overcast darkness, rain, flash, wetness) and a few lights / uniforms in the scene.
import * as THREE from 'three';
import { GLOBALS } from './globals.js';
import { skyMaterial, cloudUniforms } from './atmosphere.js';

export const WEATHERS = {
  //          cloud cover, cloud-shadow strength, cloud darkness, rain, wetness, haze x, sun x, grey sky
  clear:    { cover: 0.36, shade: 0.55, dark: 0.0,  rain: 0, wet: 0,    haze: 1.0, sun: 1.0,  grey: 0 },
  cloudy:   { cover: 0.62, shade: 0.6,  dark: 0.15, rain: 0, wet: 0,    haze: 1.25, sun: 0.92, grey: 0.15 },
  overcast: { cover: 1.05, shade: 0.7,  dark: 0.5,  rain: 0, wet: 0.2,  haze: 1.8, sun: 0.42, grey: 0.65 },
  rain:     { cover: 1.3,  shade: 0.8,  dark: 0.85, rain: 1, wet: 1,    haze: 2.6, sun: 0.22, grey: 0.9, storm: true },
};
const KEYS = Object.keys(WEATHERS.clear).filter((k) => k !== 'storm');
const GREY_HORIZON = new THREE.Color(0.56, 0.59, 0.62), GREY_ZENITH = new THREE.Color(0.33, 0.36, 0.41);
const GREY_LIGHT = new THREE.Color(0.86, 0.88, 0.9);

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

  /** 'clear' | 'cloudy' | 'overcast' | 'rain' | 'auto' (a delta afternoon: mostly fair, now and then a shower). */
  set(name) {
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
    const w = this.now, B = this.base;
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
    GLOBALS.uHorizon.value.copy(B.horizon).lerp(GREY_HORIZON, w.grey);
    GLOBALS.uZenith.value.copy(B.zenith).lerp(GREY_ZENITH, w.grey);
    if (this.scene.fog?.isFogExp2) this.scene.fog.density *= w.haze;
    this.scene.fog?.color.lerp(GREY_HORIZON, w.grey * 0.6);
    this.sun.intensity = B.sun * w.sun;
    this.sun.color.copy(B.sunColor).lerp(GREY_LIGHT, w.grey);
    if (this.hemi) {
      this.hemi.intensity = B.hemi * (1 + 1.3 * w.grey) + this.flash * 2.5;
      this.hemi.color.copy(B.hemiSky).lerp(GREY_LIGHT, w.grey);
    }
    this.scene.environmentIntensity = B.env * (1 + 0.7 * w.grey);
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
      p.uniforms.uWarm.value = p.userData.base.warm * (1 - 0.85 * w.grey);
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
