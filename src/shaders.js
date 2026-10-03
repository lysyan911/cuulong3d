// Terrain shader additions for MeshStandardMaterial (satellite version):
//   - the map texture is satellite imagery (Sentinel-2 20 m / 10 m, or streamed high-res tiles near the camera)
//   - close-up crispness: unsharp mask when the imagery is magnified, plus fine procedural detail (soil grain,
//     canopy clumps) that fades in only where it can't shimmer (based on metres-per-pixel)
//   - water (from the near-infrared mask): imagery colour kept but toned, a crisp darker bank line,
//     current streaks, drifting swells, close-up ripples; reflects the sky and clouds (Fresnel) and glitters in the sun
//   - hills: top-down imagery stretches into streaks on steep (x3) slopes, so there it is blurred and overlaid
//     with detail projected along the slope (triplanar): a forest canopy of tree crowns, or granite with
//     cracks and boulders, both lit as bumps
//   - closer than ~4 m per pixel: CC0 ground photographs (render/ground.js) laid over the satellite colour by
//     surface: wet mud, young rice, bunds, grass, dirt yards/paths, mud banks, granite
// Water mask: R = water, G = shallows. Sampled at vGroupUv * uMaskXf.xy + uMaskXf.zw (identity for the 20 m mask,
// the sub-tile transform for 10 m masks). World space: x = east, y = up (heights x exag), z = -north.

import * as THREE from 'three';
import { FIELD } from './surface.js';
import { skyUniforms, patchCloudShadow, SKY_GLSL } from './render/atmosphere.js';
import { GROUND } from './render/ground.js';
const NO_CROP = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
NO_CROP.needsUpdate = true;

const GLSL_COMMON = /* glsl */ `
varying vec3 vWPos;
varying vec2 vGroupUv;
varying vec3 vWNormal;
uniform sampler2D uMask;
uniform sampler2D uCrop;
uniform float uRice;
uniform vec4 uField;
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
// tree crowns of a given size: 0 in the gaps, 1 on the crown tops; fades to its average before it can shimmer
float canopy(vec2 p, float size, float px) {
  float vis = 1.0 - smoothstep(size * 0.15, size * 0.5, px);
  if (vis < 0.01) return 0.62;
  vec2 q = p / size, i = floor(q), f = fract(q);
  float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(hash12(i + g), hash12(i + g + 19.7)) * 0.8 + 0.1;
    d = min(d, length(g + o - f) / (0.55 + 0.4 * hash12(i + g + 7.3)));
  }
  return mix(0.62, sqrt(max(1.0 - d * d, 0.0)), vis);
}
// granite: blocky boulders with dark joints and fine grain
float granite(vec2 p, float px) {
  float vis = 1.0 - smoothstep(0.6, 2.5, px);
  if (vis < 0.01) return 0.5;
  vec2 q = p / 4.0, i = floor(q), f = fract(q);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    float d = length(g + vec2(hash12(i + g + 3.1), hash12(i + g + 8.9)) - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  float joint = smoothstep(0.0, 0.12, d2 - d1);
  return mix(0.5, joint * (0.75 + 0.25 * vnoise(p * 1.7)), vis);
}
// bump-mapped normal from a height's screen-space derivatives (like three's perturbNormalArb)
vec3 bumpNormal(vec3 surfPos, vec3 n, vec2 dHdxy) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * n - grad);
}
uniform mediump sampler2DArray uGround, uGroundN;   // ground photos: colour / OpenGL normals, one layer per surface
uniform vec3 uGroundMean[6];
uniform float uGroundTile[6];
uniform float uGroundOn;
// one ground photo at map point p (metres). Seen from afar a 2-3 m photo would average out to a flat colour, so the
// tile grows with distance in octaves (s, 2s; the second one rotated, which also hides the repeat) and the two are
// cross-faded by f: there is always grain of a few pixels on screen. Adds weight * colour and weight * normal (xy,
// map axes east / north).
void groundTap(int i, vec2 p, vec2 gx, vec2 gy, float s, float f, float w, inout vec3 col, inout vec2 nrm) {
  float t1 = uGroundTile[i] * s, t2 = t1 * 2.0, l = float(i);
  const mat2 R = mat2(0.6, 0.8, -0.8, 0.6);
  vec2 u1 = p / t1, u2 = R * p / t2 + 0.37;
  vec2 g1x = gx / t1, g1y = gy / t1, g2x = R * gx / t2, g2y = R * gy / t2;
  vec3 c = mix(textureGrad(uGround, vec3(u1, l), g1x, g1y).rgb, textureGrad(uGround, vec3(u2, l), g2x, g2y).rgb, f);
  vec2 n1 = textureGrad(uGroundN, vec3(u1, l), g1x, g1y).xy * 2.0 - 1.0;
  vec2 n2 = transpose(R) * (textureGrad(uGroundN, vec3(u2, l), g2x, g2y).xy * 2.0 - 1.0);
  col += w * c;
  nrm += w * mix(n1, n2, f);
}
const vec2 FLOW = vec2(0.83, -0.55);          // Mekong flows NW -> SE (east, north)
float waveHeight(vec2 p, float nearF) {
  vec2 q = p - FLOW * uTime * 6.0;            // drift downstream
  float swell = fbm(q / 160.0 + vec2(uTime * 0.012, 0.0));
  float ripple = vnoise(q / 14.0 + vec2(uTime * 0.35, -uTime * 0.27));
  return swell * 0.35 + ripple * 0.12 * nearF;
}
`;

/**
 * @param opts.maskXf    [repeatU, repeatV, offsetU, offsetV] mapping group UV -> mask UV
 * @param opts.texelM    metres per map texel (20 base, 10 detail, ~2.4 streamed)
 */
export function patchTerrainMaterial(material, maskTexture, shared, { maskXf = [1, 1, 0, 0], texelM = 20, crop = null } = {}) {
  const uniforms = {
    uMask: { value: maskTexture },
    uCrop: { value: crop || NO_CROP },
    uRice: shared.uRice || { value: 0 },
    uField: { value: new THREE.Vector4(FIELD.width, FIELD.depth, FIELD.angle, FIELD.bundHeight) },
    uMaskXf: { value: new THREE.Vector4(...maskXf) },
    uTexel: { value: new THREE.Vector2(1 / 1344, 1 / 1344) },
    uTexelM: { value: texelM },
    uDetail: shared.uDetail,
  };
  material.userData.terrainUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, GROUND, { uTime: shared.uTime, uExag: shared.uExag });
    const img = material.map && material.map.image;
    if (img && img.width) uniforms.uTexel.value.set(1 / img.width, 1 / img.height);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec2 vGroupUv;\nvarying vec3 vWNormal;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvWNormal = objectNormal;')
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

        // hills: forest canopy / granite instead of stretched imagery on steep slopes
        vec3 nW = normalize(vWNormal);
        float hillF = smoothstep(10.0, 28.0, vWPos.y / uExag) * (1.0 - waterF);
        float steepF = 1.0 - smoothstep(0.45, 0.92, abs(nW.y));
        float hillBump = 0.0, hillBumpK = 0.0, rockW = 0.0, hillDirt = 0.0;
        vec3 aN = abs(nW);
        vec2 rockP = aN.x > aN.y && aN.x > aN.z ? vWPos.zy : (aN.y > aN.z ? P : vWPos.xy);   // dominant plane
        vec2 rockGx = dFdx(rockP), rockGy = dFdy(rockP), groundGx = dFdx(P), groundGy = dFdy(P);
        if (hillF > 0.01) {
          vec3 base = diffuseColor.rgb;
          #ifdef USE_MAP
            base = mix(base, texture2D(map, vMapUv, 3.0).rgb, steepF * 0.9);
          #endif
          float green = smoothstep(-0.005, 0.035, base.g - max(base.r, base.b) * 0.93);
          float bright = dot(base, vec3(0.333));
          // projection planes weighted by the surface normal (on the displayed surface: sizes stay true on screen)
          vec3 tw = pow(abs(nW), vec3(3.0)); tw /= tw.x + tw.y + tw.z;
          float crown = 0.0, rock = 0.0, wsum = 0.0;
          // two sizes of crowns: single trees (6.5 m) close up, clumps of trees (22 m) out to a few km
          float clumps = 0.0;
          if (tw.x > 0.12) { crown += tw.x * canopy(vWPos.zy, 6.5, px); clumps += tw.x * canopy(vWPos.zy + 3.7, 22.0, px); rock += tw.x * granite(vWPos.zy, px); wsum += tw.x; }
          if (tw.y > 0.12) { crown += tw.y * canopy(vWPos.xz, 6.5, px); clumps += tw.y * canopy(vWPos.xz + 3.7, 22.0, px); rock += tw.y * granite(vWPos.xz, px); wsum += tw.y; }
          if (tw.z > 0.12) { crown += tw.z * canopy(vWPos.xy, 6.5, px); clumps += tw.z * canopy(vWPos.xy + 3.7, 22.0, px); rock += tw.z * granite(vWPos.xy, px); wsum += tw.z; }
          crown /= wsum; rock /= wsum; clumps /= wsum;
          crown = mix(crown, crown * (0.55 + 0.6 * clumps), 0.8);
          float grove = vnoise(P / 45.0);
          // canopy only on dark-green forest (grass and scrub are lighter); subtle close up where real trees stand
          float forestF = green * (1.0 - smoothstep(0.07, 0.15, bright));
          float crownK = forestF * mix(0.35, 1.0, smoothstep(0.8, 3.0, px));
          vec3 forest = base * mix(1.0, mix(0.42, 1.28, crown), crownK) * (0.86 + 0.28 * grove);
          // bare granite where the imagery is bright and not green (Núi Dài, Núi Tô, summit rocks)
          float rockF = (1.0 - green) * smoothstep(0.09, 0.2, bright) * (0.6 + 0.4 * steepF);
          vec3 granCol = mix(base, vec3(0.30, 0.285, 0.255), 0.45) * mix(0.55, 1.15, rock);
          vec3 hillCol = mix(forest, granCol, rockF);
          diffuseColor.rgb = mix(diffuseColor.rgb, hillCol, hillF * (0.6 + 0.4 * steepF));
          hillBump = mix((crown * 2.6 + clumps * 4.0) * crownK, rock * 0.9, rockF);
          hillBumpK = hillF * (1.0 - smoothstep(4.0, 14.0, px));
          rockW = hillF * rockF * smoothstep(0.08, 0.4, steepF);   // rock photo on slopes; bare flats are dirt
          hillDirt = hillF * rockF - rockW;
        }

        // Lowland rice parcels: raised bunds, young wet rows, green growth and golden ripening.
        // Field layout is illustrative; cropland, buildings and roads come from the cover mask.
        vec3 cropS = texture2D(uCrop, vGroupUv).rgb;    // R rice (surface.py), G paved, B town density (urban.py)
        float riceCover = smoothstep(0.35, 0.85, cropS.r) * uRice * (1.0 - waterF);
        riceCover *= 1.0 - smoothstep(12.0, 40.0, px);
        float paddyWet = 0.0, riceStage = 0.5, riceBund = 0.0;
        if (riceCover > 0.01) {
        float ca = cos(uField.z), sa = sin(uField.z);
        vec2 fieldP = vec2(P.x * ca + P.y * sa, -P.x * sa + P.y * ca);
        vec2 cell = floor(fieldP / uField.xy);
        vec2 local = mod(fieldP, uField.xy);
        float stage = hash12(cell + 71.3);
        float edge = min(min(local.x, uField.x - local.x), min(local.y, uField.y - local.y));
        float bund = 1.0 - smoothstep(0.65, 1.8 + px, edge);
        float rowVis = 1.0 - smoothstep(0.18, 0.75, px);
        float riceRow = 0.5 + 0.5 * sin(fieldP.x * 13.9626); // 45 cm planted rows
        float growth = fbm(P / 35.0);
        vec3 riceColour = stage < 0.20 ? vec3(0.115, 0.16, 0.082)
                        : stage < 0.52 ? vec3(0.14, 0.28, 0.042)
                        : stage < 0.82 ? vec3(0.08, 0.21, 0.032) : vec3(0.34, 0.31, 0.083);
        riceColour *= 0.88 + 0.23 * growth + (riceRow - 0.5) * 0.17 * rowVis;
        riceColour = mix(riceColour, vec3(0.145, 0.17, 0.075), bund * 0.8);
        diffuseColor.rgb = mix(diffuseColor.rgb, riceColour, riceCover * 0.58);
        paddyWet = riceCover * (1.0 - step(0.20, stage)) * (1.0 - bund);
        riceStage = stage; riceBund = bund;
        }

        // paved ground: concrete between the houses of a town, packed-earth yards around village houses. Replaces the
        // satellite image there (its roof prints and shadows would lie on the ground under the 3D houses)
        float paved = cropS.g * (1.0 - waterF) * (1.0 - riceCover) * (1.0 - hillF * 0.8);
        float townK = smoothstep(0.15, 0.7, cropS.b);
        if (paved > 0.01) {
          vec3 sat = diffuseColor.rgb;
          float gn = vnoise(P / 8.0) * 0.6 + vnoise(P / 2.3) * 0.4;
          vec3 concrete = vec3(0.30, 0.29, 0.27) * (0.8 + 0.35 * gn);
          vec3 earth = vec3(0.20, 0.155, 0.11) * (0.8 + 0.4 * gn);
          vec3 groundC = mix(earth, concrete, townK);
          float nearK = mix(0.45, 1.0, 1.0 - smoothstep(800.0, 4000.0, camDist));
          diffuseColor.rgb = mix(sat, mix(groundC, sat, 0.2), smoothstep(0.0, 0.6, paved) * nearK);
        }

        // close up: ground photographs by surface, their detail laid over the satellite / rice colour
        float groundK = uGroundOn * (1.0 - smoothstep(1.5, 4.0, px)) * (1.0 - waterF);
        vec2 groundN = vec2(0.0);
        float groundWet = 0.0;
        if (groundK > 0.01) {
          vec3 sat = diffuseColor.rgb;
          float vegG = smoothstep(0.0, 0.035, sat.g - max(sat.r, sat.b) * 0.95);
          float land = max(1.0 - riceCover - hillF, 0.0);
          float mudBank = smoothstep(0.03, 0.2, msk.r) * land;               // shore band next to the water
          float yard = max(land - mudBank, 0.0);
          float field = riceCover * (1.0 - riceBund);
          float w[6];
          w[0] = field * step(riceStage, 0.2) + mudBank;                       // flooded / wet mud
          w[1] = riceCover * riceBund * 0.6;                                   // dry bunds
          w[2] = yard * vegG + riceCover * riceBund * 0.4;                     // grass
          w[3] = yard * (1.0 - vegG) + hillDirt;                               // dirt yards, paths, bare hill flats
          w[4] = rockW;                                                        // granite
          w[5] = field * (1.0 - step(riceStage, 0.2));                         // young / growing rice
          float gLod = log2(max(px / 0.02, 1.0)), gS = exp2(floor(gLod)), gF = fract(gLod);   // ~0.02 m per pixel at s = 1
          vec3 pc = vec3(0.0), pm = vec3(0.0);
          float W = 0.0;
          for (int i = 0; i < 6; i++) {
            if (w[i] > 0.02) {
              if (i == 4) groundTap(i, rockP, rockGx, rockGy, gS, gF, w[i], pc, groundN);
              else groundTap(i, P, groundGx, groundGy, gS, gF, w[i], pc, groundN);
              pm += w[i] * uGroundMean[i];
              W += w[i];
            }
          }
          if (W > 0.02) {
            pc /= W; pm /= W; groundN /= W;
            float L0 = max(dot(pm, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
            // photo detail on the satellite colour (contrast softened), part photo colour at the satellite brightness
            vec3 detailed = sat * mix(vec3(1.0), pc / max(pm, vec3(1e-3)), 0.7);
            vec3 tinted = pc * dot(sat, vec3(0.2126, 0.7152, 0.0722)) / L0;
            float k = groundK * min(W, 1.0);
            diffuseColor.rgb = mix(sat, mix(detailed, tinted, 0.35), k);
            float grey = paved * townK * 0.75;                                   // town concrete: grey, not brown dirt
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))) * vec3(1.0, 0.99, 0.96), grey);
            groundN *= k;
            groundWet = k * w[0] / W;
          }
        }

        // water: keep the photographed colour (silty Mekong / clear lakes) but even it out, add current streaks
        float lake = smoothstep(6.0, 9.0, vWPos.y / uExag);
        vec2 qq = vec2(dot(P, FLOW), dot(P, vec2(-FLOW.y, FLOW.x)));   // along / across the flow
        float streak = smoothstep(0.38, 0.66, fbm(vec2(qq.x / 700.0 - uTime * 0.01, qq.y / 60.0)));
        vec3 photo = diffuseColor.rgb;
        vec3 tone = mix(vec3(0.16, 0.135, 0.083), vec3(0.025, 0.12, 0.105), lake);
        vec3 wcol = mix(photo, tone, 0.72 - 0.08 * shallowF) * mix(0.96, 1.05, streak);
        diffuseColor.rgb = mix(photo, wcol, waterF);
        // clear river bank: darken the water edge slightly
        float bankVis = bank * (1.0 - smoothstep(4000.0, 20000.0, camDist));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.11, 0.085, 0.047), bankVis * 0.45);
      `)
      .replace('#include <lights_pars_begin>', `${SKY_GLSL}\n#include <lights_pars_begin>`)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.56, paddyWet * 0.6);
        roughnessFactor = mix(roughnessFactor, 0.62, groundWet * 0.7);
        roughnessFactor = mix(roughnessFactor, mix(0.38, 0.28, streak), waterF);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        if (hillBumpK > 0.01) normal = bumpNormal(-vViewPosition, normal, vec2(dFdx(hillBump), dFdy(hillBump)) * hillBumpK);
        if (groundK > 0.01) normal = normalize(normal + (viewMatrix * vec4(groundN.x, 0.0, -groundN.y, 0.0)).xyz * 0.7);
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
      `)
      .replace('#include <opaque_fragment>', /* glsl */ `
        // water: the photographed colour lit as before, plus the sky and clouds reflected (Fresnel) and sun glitter
        // (the shadow-mapped, cloud-dimmed sun from the light loop, so shade under trees and clouds has none)
        if (waterF > 0.01) {
          vec3 wN = normalize(transpose(mat3(viewMatrix)) * normal);
          vec3 wV = normalize(cameraPosition - vWPos);
          float NdV = max(dot(wN, wV), 0.05);
          float Fr = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
          vec3 R = reflect(-wV, wN); R.y = max(R.y, 0.01);
          float cover;
          vec3 skyR = skyRadiance(normalize(R), vWPos, 1.0, cover);
          skyR *= 1.0 - 0.6 * bank;                            // banks and their trees darken the edge reflection
          // mirror image of the banks: follow the reflected ray over the water mask; land (trees, houses ~18 m) that
          // it passes below hides the sky. Group UV runs 0..1 east / north over 26.88 km.
          vec2 rh = normalize(vec2(R.x, -R.z) + 1e-5);
          float rise = R.y / max(length(R.xz), 1e-3), occ = 0.0;
          for (int i = 1; i <= 6; i++) {
            float s = 12.0 * pow(2.2, float(i));               // 26 m .. 1.4 km
            float land = 1.0 - smoothstep(0.3, 0.6, texture2D(uMask, (vGroupUv + rh * s / 26880.0) * uMaskXf.xy + uMaskXf.zw).r);
            occ = max(occ, land * (1.0 - smoothstep(10.0, 18.0, rise * s)));
          }
          vec3 bankCol = vec3(0.07, 0.085, 0.05) * (0.75 + 0.5 * vnoise(P / 60.0));
          skyR = mix(skyR, bankCol, occ * 0.9);
          // near the viewer: the mirrored scene (render/reflection.js), rippled by the wave normal
          if (uRefl.x > 0.5) {
            vec4 rc = uReflMatrix * vec4(vWPos.x, uRefl.y, vWPos.z, 1.0);
            float rk = (1.0 - smoothstep(uRefl.z * 0.6, uRefl.z, camDist)) * (1.0 - smoothstep(1.5, 6.0, abs(vWPos.y - uRefl.y)));
            if (rc.w > 0.0 && rk > 0.0) {
              vec2 ruv = rc.xy / rc.w + wN.xz * 0.25;
              vec4 mir = texture2D(uReflMap, clamp(ruv, vec2(0.001), vec2(0.999)));
              skyR = mix(skyR, mir.rgb, mir.a * rk);
            }
          }
          vec3 glint = vec3(0.0);
          #if NUM_DIR_LIGHTS > 0
            vec3 H = normalize(wV + uSunDir);
            float c = max(dot(wN, H), 1e-3), c2 = c * c;
            float s2 = mix(0.0025, 0.035, smoothstep(0.5, 25.0, px));    // wider sun path when a pixel spans many ripples
            float D = exp((c2 - 1.0) / (c2 * s2)) / (PI * s2 * c2 * c2);
            float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(wV, H), 0.0), 5.0);
            float closeF = 1.0 - smoothstep(0.3, 3.0, px);                  // separate sparkles close up
            float sp = vnoise(P * 1.7 + uTime * vec2(0.9, -0.7)) * vnoise(P * 2.3 - uTime * vec2(0.5, 1.1));
            glint = directLight.color * D * Fh / (4.0 * NdV) * mix(1.0, 12.0 * pow(sp, 1.5), closeF);
          #endif
          vec3 waterLit = totalDiffuse * (1.0 - Fr) + skyR * Fr + glint + totalEmissiveRadiance;
          outgoingLight = mix(outgoingLight, waterLit, waterF);
        }
        #include <opaque_fragment>
      `);
    patchCloudShadow(shader, skyUniforms());
  };
  material.customProgramCacheKey = () => 'cuulong-terrain-paved-v9';
}
