// Uniforms shared by many materials, updated once per frame by main.js.
//   uViewPos   the viewer's camera position. Use it instead of `cameraPosition` for distance-based level of detail,
//              so the shadow pass (rendered from the sun) keeps the same instances as the picture.
//   uCloud*    the cloud layer (see atmosphere.js) for cloud shadows.
//   uHorizon / uZenith  sky colours (set by main.js), for the sky dome and water reflections.
//   uWeather   overcast darkness 0-1, rain 0-1, lightning flash 0-1, wetness 0-1 (render/weather.js)
//   uRefl*     planar water reflection (reflection.js): on, water height, range; picture; world -> picture UV.
import * as THREE from 'three';

export const GLOBALS = {
  uViewPos: { value: new THREE.Vector3() },
  uCloud: { value: new THREE.Vector4(0.36, 3000, 0.55, 0) },   // coverage, layer height (m), shadow strength
  uSunDir: { value: new THREE.Vector3(-0.60, 0.53, 0.60).normalize() },   // from the south-west, ~32° up (about 16:00)
  uCloudTime: { value: 0 },
  uHorizon: { value: new THREE.Color(0.64, 0.75, 0.88) },   // humid horizon
  uZenith: { value: new THREE.Color(0.08, 0.23, 0.58) },
  uWeather: { value: new THREE.Vector4(0, 0, 0, 0) },
  uRefl: { value: new THREE.Vector4(0, 0, 4000, 0) },
  uReflMap: { value: null },
  uReflMatrix: { value: new THREE.Matrix4() },
};
