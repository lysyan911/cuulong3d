// Sky, clouds and cloud shadows.
//
// One cloud field (fbm, drifting with the wind) lives on a flat layer at uCloud.y metres. The sky dome ray-casts to
// that layer, so the clouds you see overhead are the same ones whose shadows cross the ground: any lit material
// patched with patchCloudShadow() dims its sunlight by the cloud above it along the sun direction.
import * as THREE from 'three';
import { GLOBALS } from './globals.js';

export const CLOUD_GLSL = /* glsl */ `
uniform vec4 uCloud;     // coverage 0..1, layer height (scene m), shadow strength, -
uniform vec3 uSunDir;    // towards the sun
uniform float uCloudTime;
uniform vec4 uWeather;   // overcast darkness, rain, lightning flash, wetness (render/weather.js)
float cHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float cNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash(i), cHash(i + vec2(1, 0)), f.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), f.x), f.y);
}
// cumulus density 0..1 at world (x, z) on the cloud layer
float cloudField(vec2 p) {
  vec2 q = p / 5200.0 + uCloudTime * vec2(0.0011, 0.0004);        // ~7 m/s wind from the WSW
  float f = 0.0, a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) { f += a * cNoise(q); q = rot * q * 2.07 + 11.3; a *= 0.5; }
  // fbm sits around 0.48 +- 0.12: thresholds chosen so the coverage is roughly the cloudy fraction of the sky
  float t0 = 0.62 - uCloud.x * 0.3;
  return smoothstep(t0, t0 + 0.13, f);
}
// sunlight factor at a world position: 1 in the sun, lower under a cloud
float cloudShadow(vec3 wp) {
  vec2 pc = wp.xz + uSunDir.xz / max(uSunDir.y, 0.25) * (uCloud.y - wp.y);
  return 1.0 - uCloud.z * cloudField(pc);
}
`;

/** The cloud uniforms (shared, see globals.js). */
export function cloudUniforms() {
  return { uCloud: GLOBALS.uCloud, uSunDir: GLOBALS.uSunDir, uCloudTime: GLOBALS.uCloudTime, uWeather: GLOBALS.uWeather };
}

/** Cloud + sky colour uniforms, for materials that use SKY_GLSL (water reflections). */
export function skyUniforms() {
  return { ...cloudUniforms(), uHorizon: GLOBALS.uHorizon, uZenith: GLOBALS.uZenith,
           uRefl: GLOBALS.uRefl, uReflMap: GLOBALS.uReflMap, uReflMatrix: GLOBALS.uReflMatrix };
}

/** Dim the sun by the clouds above (MeshStandard/Physical-based shaders). Call inside onBeforeCompile. */
export function patchCloudShadow(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  const lights = THREE.ShaderChunk.lights_fragment_begin.replace(
    'getDirectionalLightInfo( directionalLight, directLight );',
    `getDirectionalLightInfo( directionalLight, directLight );
     directLight.color *= cloudShade;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + CLOUD_GLSL)
    .replace('#include <lights_fragment_begin>', `
      // world position from the view-space position (rigid view matrix)
      vec3 cloudWP = transpose(mat3(viewMatrix)) * (-vViewPosition - viewMatrix[3].xyz);
      float cloudShade = cloudShadow(cloudWP);
      #ifdef STANDARD
      if (uWeather.w > 0.001) {                  // rain: wet surfaces (facing up) darker and glossier, puddles on the flat
        float up = (transpose(mat3(viewMatrix)) * normal).y;
        float wetK = uWeather.w * smoothstep(0.2, 0.8, up) * smoothstep(0.4, 0.6, material.roughness);   // (water is already wet)
        float pud = smoothstep(0.58, 0.66, cNoise(cloudWP.xz * 0.33) * 0.7 + cNoise(cloudWP.xz * 1.3) * 0.3) * smoothstep(0.93, 0.99, up) * wetK;
        material.diffuseColor *= 1.0 - 0.3 * wetK - 0.25 * pud;
        material.roughness = mix(material.roughness, mix(0.5, 0.08, pud), 0.7 * wetK);
        normal = normalize(mix(normal, viewMatrix[1].xyz, pud));   // standing water is flat (no glittering bumps)
      }
      #endif
      ${lights}`);
}

// Sky radiance (linear HDR) seen from `from` looking along d: gradient, sun glow, lit cumulus on the cloud layer.
// Needs CLOUD_GLSL before it. `cover` returns the cloud density in that direction.
export const SKY_GLSL = /* glsl */ `
uniform vec3 uHorizon, uZenith;
uniform vec4 uRefl;          // planar reflection: on, water height, range (render/reflection.js)
uniform sampler2D uReflMap;
uniform mat4 uReflMatrix;
vec3 skyRadiance(vec3 d, vec3 from, float withClouds, out float cover) {
  float e = d.y, mu = dot(d, uSunDir);
  vec3 col = mix(uHorizon, uZenith, pow(clamp(e, 0.0, 1.0), 0.48));
  col += vec3(1.0, 0.80, 0.52) * (0.12 * pow(max(mu, 0.0), 5.0) + 0.45 * pow(max(mu, 0.0), 60.0)) * (1.0 - 0.9 * uWeather.x);   // sun glow
  col = mix(col, uHorizon * 0.9, smoothstep(0.0, -0.15, e));                                         // haze below
  cover = 0.0;
  if (withClouds > 0.5 && e > 0.005 && from.y < uCloud.y) {
    float t = (uCloud.y - from.y) / e;
    vec2 p = from.xz + d.xz * t;
    float dens = cloudField(p) * (1.0 - smoothstep(25000.0, 80000.0, t));
    if (dens > 0.001) {
      float toSun = cloudField(p + uSunDir.xz / max(uSunDir.y, 0.25) * 350.0);   // thicker towards the sun = darker
      float light = clamp(1.0 - 0.75 * toSun + 0.2 * (1.0 - dens), 0.0, 1.0);
      vec3 cloud = mix(vec3(0.50, 0.55, 0.63), vec3(1.05, 1.0, 0.94), light);
      cloud += vec3(1.0, 0.85, 0.6) * pow(max(mu, 0.0), 12.0) * (1.0 - dens) * 0.9;   // silver lining
      cloud *= 1.0 - 0.55 * uWeather.x * (0.6 + 0.4 * toSun);                       // rain clouds: dark grey, darker bases
      cloud += vec3(0.85, 0.88, 1.0) * uWeather.z * (0.6 + 0.8 * dens);             // lightning inside the clouds
      cloud = mix(cloud, uHorizon, smoothstep(8000.0, 70000.0, t) * 0.7);           // aerial haze
      col = mix(col, cloud, dens);
      cover = dens;
    }
  }
  return col;
}
`;

/** Sky dome: blue gradient, sun glow and disc (HDR, so it blooms), lit cumulus on the cloud layer. */
export function skyMaterial(uniforms, { horizon, zenith }) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: { ...uniforms, uHorizon: { value: horizon }, uZenith: { value: zenith },
                uCam: { value: new THREE.Vector3() }, uClouds: { value: 1 } },
    vertexShader: /* glsl */ `varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `varying vec3 vDir;
      uniform vec3 uCam; uniform float uClouds;
      ${CLOUD_GLSL}
      ${SKY_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        float cover;
        vec3 col = skyRadiance(d, uCam, uClouds, cover);
        col += vec3(1.0, 0.94, 0.82) * smoothstep(0.99955, 0.99985, dot(d, uSunDir)) * 12.0 * (1.0 - cover);   // sun disc
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * Aerial perspective for every built-in material: replaces three's fog chunks. With scene.fog = FogExp2, fogDensity
 * is the haze extinction at sea level (per m) and it thins out with height (scale height HAZE_H), so low views over
 * the delta fade to the haze colour within ~10-20 km while views from high above stay clear. Linear Fog still works
 * as before (used under the Trà Sư canopy). Call once, before any material compiles.
 * The haze colour is worked out per pixel from the angle to the sun (sunDir, fixed for the session): fogColor is the
 * horizon blue; looking towards the sun the haze glows warm (forward scattering by the humid air), looking away it
 * turns a deeper blue, so far hills fade into blue layers rather than grey.
 */
export const HAZE_H = 1100;
export function installAerialHaze(sunDir) {
  if (THREE.ShaderChunk.fog_fragment.includes('vFogWorld')) return;
  THREE.ShaderChunk.fog_pars_vertex = '#ifdef USE_FOG\n  varying float vFogDepth;\n  varying vec3 vFogWorld;\n#endif';
  THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    vFogWorld = transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz);
  #endif`;
  THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
    uniform vec3 fogColor;
    varying float vFogDepth;
    varying vec3 vFogWorld;
    #ifdef FOG_EXP2
      uniform float fogDensity;
    #else
      uniform float fogNear;
      uniform float fogFar;
    #endif
  #endif`;
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
    #ifdef FOG_EXP2
      // optical depth through haze of density fogDensity * exp(-y / H) along the view ray
      vec3 fogRay = vFogWorld - cameraPosition;
      float fogLen = length(fogRay), fogB = 1.0 / ${HAZE_H.toFixed(1)};
      float fogK = fogRay.y * fogB;
      float fogOd = fogDensity * exp(-max(cameraPosition.y, 0.0) * fogB) * fogLen
                  * (abs(fogK) > 1e-3 ? (1.0 - exp(-fogK)) / fogK : 1.0);
      float fogFactor = 1.0 - exp(-fogOd);
      vec3 fogDir = fogRay / max(fogLen, 1.0);
      float fogMu = dot(fogDir, vec3(${sunDir.x.toFixed(4)}, ${sunDir.y.toFixed(4)}, ${sunDir.z.toFixed(4)}));
      float fogMie = 0.42 * pow(max(fogMu, 0.0), 6.0) + 0.16 * max(fogMu, 0.0) * max(fogMu, 0.0);
      // (a little darker than the sky at the horizon, so it keeps its blue through the tone mapping)
      vec3 fogCol = mix(fogColor * vec3(0.76, 0.88, 1.02), vec3(1.0, 0.84, 0.62), clamp(fogMie, 0.0, 1.0));
      fogCol = mix(fogCol, fogColor * vec3(0.66, 0.80, 1.0), 0.5 * max(-fogMu, 0.0));
    #else
      vec3 fogCol = fogColor;
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogCol, fogFactor );
  #endif`;
}

