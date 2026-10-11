// The map table (Claude Code, rendering): beyond the 3D map lies an antique hand-coloured map of the lower Mekong,
// as Civilization VI shows unexplored land as a parchment map. A large plane just under the terrain is paper (fibres,
// stains, foxing) with the ink sheet from scripts/offmap.py (web/ui/map) laid on it and a graticule every 15'; beyond
// the sheet the paper is darker, like the desk under a map. Seen from high up (uMapMode, from the camera height), the
// terrain outside the province turns into the same sheet (shaders.js), so the province stands out in colour and the
// square edge of the data disappears. MAP_GLSL is shared by both materials (self-contained, mt-prefixed helpers).
import * as THREE from 'three';
import { cloudUniforms, patchCloudShadow } from './atmosphere.js';

// scene centre in degrees and metres per degree there (scripts/offmap.py, UTM 48N)
const LON0 = 105.17535, LAT0 = 10.57011, MLON = 109400, MLAT = 110568;

export const MAP_GLSL = /* glsl */ `
uniform sampler2D uSheet;
uniform vec4 uSheetBox;      // x0, y0 (south-west, scene m), width, height
uniform sampler2D uProvince;
uniform vec4 uProvBox;
uniform float uMapMode;      // 0 near the ground .. 1 seen from high up
float mtHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float mtNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mtHash(i), mtHash(i + vec2(1, 0)), u.x), mix(mtHash(i + vec2(0, 1)), mtHash(i + vec2(1, 1)), u.x), u.y);
}
float mtFbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * mtNoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s / 0.9375; }
// one octave that fades out before it shimmers (px = metres per screen pixel)
float mtOct(vec2 p, float m, float px) { return (mtNoise(p / m) - 0.5) * (1.0 - smoothstep(0.25, 0.5, px / m)); }
// aged paper: warm cream, slow stains, foxing spots, fibres close up
vec3 mtPaper(vec2 P, float px) {
  vec3 c = vec3(0.80, 0.70, 0.50);
  c *= 0.92 + 0.14 * mtFbm(P / 21000.0);
  c *= 1.0 - 0.10 * smoothstep(0.66, 0.86, mtFbm(P / 4300.0 + 3.1));
  c *= 1.0 - 0.14 * smoothstep(0.78, 0.9, mtNoise(P / 700.0 + 7.7)) * (1.0 - smoothstep(60.0, 160.0, px));
  c *= 1.0 + 0.09 * mtOct(P, 900.0, px) + 0.07 * mtOct(P * vec2(1.0, 3.0), 160.0, px) + 0.05 * mtOct(P, 40.0, px);
  return c;
}
vec3 oldMap(vec2 P, float px) {
  vec3 c = mtPaper(P, px);
  vec2 uv = (P - uSheetBox.xy) / uSheetBox.zw;
  vec2 e = min(uv, 1.0 - uv) * uSheetBox.zw;          // metres inside the sheet edge (negative outside)
  float inSheet = step(0.0, min(e.x, e.y));
  if (inSheet > 0.5) {
    c *= texture2D(uSheet, uv).rgb;
    // graticule every 15', fine ink (the sheet carries the degree scale on its neat line)
    vec2 ll = vec2(${LON0} + P.x / ${MLON}.0, ${LAT0} + P.y / ${MLAT}.0);
    vec2 g = abs(fract(ll * 4.0 + 0.5) - 0.5) * vec2(${MLON}.0, ${MLAT}.0) / 4.0;
    float w = max(px * 0.8, 70.0);
    c *= 1.0 - 0.32 * (1.0 - smoothstep(w * 0.5, w, min(g.x, g.y)));
  } else {
    // the desk under the sheet: older, browner paper, the sheet's soft shadow along its edge
    float o = -min(e.x, e.y);
    c *= vec3(0.80, 0.72, 0.62) * (1.0 - 0.32 * exp(-o / 2600.0));
    c *= 1.0 - 0.35 * smoothstep(250000.0, 700000.0, length(P));
  }
  return c;
}
float mtOutside(vec2 P) { return 1.0 - smoothstep(0.3, 0.7, texture2D(uProvince, (P - uProvBox.xy) / uProvBox.zw).r); }
`;

export class MapTable {
  constructor({ anisotropy = 8 } = {}) {
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
    const inside = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); inside.needsUpdate = true;
    this.uniforms = {
      uSheet: { value: white }, uSheetBox: { value: new THREE.Vector4(-150000, -150000, 300000, 300000) },
      uProvince: { value: inside }, uProvBox: { value: new THREE.Vector4(-52050, -49815, 104100, 99630) },
      uMapMode: { value: 0 },
    };
    const loader = new THREE.TextureLoader();
    fetch('ui/map/sheet.json').then((r) => r.json()).then((j) => {
      this.uniforms.uSheetBox.value.set(...j.sheet); this.uniforms.uProvBox.value.set(...j.province);
    }).catch(() => {});
    loader.load('ui/map/sheet.webp', (t) => {
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = anisotropy; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      this.uniforms.uSheet.value = t;
    });
    loader.load('ui/map/province.png', (t) => { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; this.uniforms.uProvince.value = t; });

    // Background paper: keep the giant plane out of scene/AO depth so it cannot occlude street geometry.
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, depthWrite: false });
    mat.onBeforeCompile = (sh) => {
      patchCloudShadow(sh, cloudUniforms());
      sh.fragmentShader = sh.fragmentShader.replace('float cloudShade = cloudShadow(cloudWP);',
        'float cloudShade = mix(cloudShadow(cloudWP), 1.0, 0.85);');      // (paper, not land: clouds barely shade it)
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vMtPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvMtPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vMtPos;\n' + MAP_GLSL)
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec2 mtP = vec2(vMtPos.x, -vMtPos.z);
          diffuseColor.rgb = oldMap(mtP, max(length(fwidth(mtP)), 1e-3));`);
    };
    mat.customProgramCacheKey = () => 'cuulong-maptable-2';
    const g = new THREE.PlaneGeometry(4000000, 4000000);
    g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'map-table';
    this.mesh.renderOrder = -5;          // after the sky (-10), before terrain and props (0)
    this.mesh.position.y = -2.5;          // paper below the lowest land and water (level 0)
    this.mesh.frustumCulled = false;
    this.mesh.userData.noShadow = true;
    this.mesh.userData.noReflect = true;
  }

  /** Map mode from the camera height: the land outside the province becomes the old map when seen from high up. */
  update(camera) {
    const h = camera.position.y;
    const k = Math.min(Math.max((h - 7000) / 13000, 0), 1);
    this.uniforms.uMapMode.value = k * k * (3 - 2 * k);
  }
}
