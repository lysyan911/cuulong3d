// Terrain shader additions for MeshStandardMaterial (satellite version):
//   - the map texture is satellite imagery (Sentinel-2 20 m / 10 m, or streamed high-res tiles near the camera)
//   - close-up crispness: unsharp mask when the imagery is magnified, plus fine procedural detail (soil grain,
//     canopy clumps) that fades in only where it can't shimmer (based on metres-per-pixel)
//   - water (from the near-infrared mask): imagery colour kept but toned, a crisp darker bank line,
//     current streaks, drifting swells, close-up ripples and sky reflections
// Water mask: R = water, G = shallows. Sampled at vGroupUv * uMaskXf.xy + uMaskXf.zw (identity for the 20 m mask,
// the sub-tile transform for 10 m masks). World space: x = east, y = up (heights x exag), z = -north.

import * as THREE from 'three';

const GLSL_COMMON = /* glsl */ `
varying vec3 vWPos;
varying vec2 vGroupUv;
uniform sampler2D uMask;
uniform vec4 uMaskXf;
uniform vec2 uTexel;     // map texel size in UV
uniform float uTexelM;   // map texel size in metres
uniform float uDetail;   // strength of the procedural ground detail
uniform float uTime;
uniform float uExag;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.9375;
}
// band-limited noise octave: fades out before it gets smaller than ~2 pixels (no shimmer)
float octave(vec2 p, float freq, float px) {
  return (vnoise(p * freq) - 0.5) * (1.0 - smoothstep(0.2, 0.45, px * freq));
}
const vec2 FLOW = vec2(0.83, -0.55);          // Mekong flows NW -> SE (east, north)
float waveHeight(vec2 p, float nearF) {
  vec2 q = p - FLOW * uTime * 6.0;            // drift downstream
  float swell = fbm(q / 160.0 + vec2(uTime * 0.012, 0.0));
  float ripple = vnoise(q / 14.0 + vec2(uTime * 0.35, -uTime * 0.27));
  return swell * 4.0 + ripple * 2.0 * nearF;
}
`;

/**
 * @param opts.maskXf    [repeatU, repeatV, offsetU, offsetV] mapping group UV -> mask UV
 * @param opts.texelM    metres per map texel (20 base, 10 detail, ~2.4 streamed)
 */
export function patchTerrainMaterial(material, maskTexture, shared, { maskXf = [1, 1, 0, 0], texelM = 20 } = {}) {
  const uniforms = {
    uMask: { value: maskTexture },
    uMaskXf: { value: new THREE.Vector4(...maskXf) },
    uTexel: { value: new THREE.Vector2(1 / 1344, 1 / 1344) },
    uTexelM: { value: texelM },
    uDetail: shared.uDetail,
  };
  material.userData.terrainUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uTime: shared.uTime, uExag: shared.uExag });
    const img = material.map && material.map.image;
    if (img && img.width) uniforms.uTexel.value.set(1 / img.width, 1 / img.height);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec2 vGroupUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvGroupUv = uv;')
      .replace('#include <project_vertex>',
        '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_COMMON)
      .replace('#include <map_fragment>', /* glsl */ `
        #include <map_fragment>
        vec2 P = vec2(vWPos.x, -vWPos.z);                 // map coords (east, north)
        float camDist = length(vWPos - cameraPosition);
        float px = max(length(fwidth(P)), 1e-3);          // metres per screen pixel here
        vec3 msk = texture2D(uMask, vGroupUv * uMaskXf.xy + uMaskXf.zw).rgb;
        float waterF = smoothstep(0.25, 0.65, msk.r);
        float bank = smoothstep(0.05, 0.3, msk.r) * (1.0 - smoothstep(0.55, 0.9, msk.r));   // thin edge band
        float shallowF = msk.g;

        // crispness 1: unsharp mask when an imagery texel covers several screen pixels
        #ifdef USE_MAP
          float sharpF = smoothstep(1.5, 4.0, uTexelM / px);
          if (sharpF > 0.0) {
            vec3 blur = 0.25 * (texture2D(map, vMapUv + vec2(uTexel.x, 0.0)).rgb + texture2D(map, vMapUv - vec2(uTexel.x, 0.0)).rgb
                              + texture2D(map, vMapUv + vec2(0.0, uTexel.y)).rgb + texture2D(map, vMapUv - vec2(0.0, uTexel.y)).rgb);
            diffuseColor.rgb = max(diffuseColor.rgb + (diffuseColor.rgb - blur) * 0.9 * sharpF, vec3(0.0));
          }
        #endif

        // crispness 2: fine ground detail by surface type (only where it resolves on screen)
        if (waterF < 0.5) {
          vec3 c = diffuseColor.rgb;
          float veg = smoothstep(0.0, 0.035, c.g - max(c.r, c.b) * 0.95);   // green: crops, grass, trees
          // 5-20 m octaves break up the 10 m pixels at mid range; finer ones add grain up close
          float grain = 0.8 * octave(P, 0.07, px) + 0.7 * octave(P + 5.0, 0.16, px) + 0.6 * octave(P, 0.35, px)
                      + 0.5 * octave(P + 31.0, 0.9, px) + 0.4 * octave(P + 7.0, 2.2, px);
          float clump = 1.1 * octave(P + 3.0, 0.09, px) + 1.0 * octave(P, 0.18, px) + 0.7 * octave(P + 13.0, 0.45, px);
          float detail = mix(grain, clump, veg);
          diffuseColor.rgb *= 1.0 + detail * uDetail;
        }

        // water: keep the photographed colour (silty Mekong / clear lakes) but even it out, add current streaks
        float lake = smoothstep(6.0, 9.0, vWPos.y / uExag);
        vec2 qq = vec2(dot(P, FLOW), dot(P, vec2(-FLOW.y, FLOW.x)));   // along / across the flow
        float streak = smoothstep(0.38, 0.66, fbm(vec2(qq.x / 700.0 - uTime * 0.01, qq.y / 60.0)));
        vec3 photo = diffuseColor.rgb;
        vec3 tone = mix(vec3(0.17, 0.13, 0.06), vec3(0.02, 0.14, 0.13), lake);
        vec3 wcol = mix(photo, tone, 0.35 - 0.2 * shallowF) * mix(0.9, 1.12, streak);
        diffuseColor.rgb = mix(photo, wcol, waterF);
        // clear river bank: darken the water edge slightly
        diffuseColor.rgb *= 1.0 - 0.22 * bank * (1.0 - smoothstep(4000.0, 20000.0, camDist));
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, mix(0.16, 0.05, streak), waterF);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        if (waterF > 0.01) {
          float nearF = 1.0 - smoothstep(800.0, 2500.0, camDist);
          float farF = mix(1.0, 0.2, smoothstep(6000.0, 45000.0, camDist));
          float e = 3.0;
          float hx = (waveHeight(P + vec2(e, 0.0), nearF) - waveHeight(P - vec2(e, 0.0), nearF)) / (2.0 * e);
          float hy = (waveHeight(P + vec2(0.0, e), nearF) - waveHeight(P - vec2(0.0, e), nearF)) / (2.0 * e);
          vec3 nW = normalize(vec3(-hx * farF, 1.0, hy * farF));     // world z = -north
          vec3 nV = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
          normal = normalize(mix(normal, nV, waterF));
        }
      `);
  };
  material.customProgramCacheKey = () => 'cuulong-terrain-sat-v3';
}
