// Uniforms shared by many materials, updated once per frame by main.js.
//   uViewPos   the viewer's camera position. Use it instead of `cameraPosition` for distance-based level of detail,
//              so the shadow pass (rendered from the sun) keeps the same instances as the picture.
//   uCloud*    the cloud layer (see atmosphere.js) for cloud shadows.
//   uHorizon / uZenith  sky colours (set by main.js), for the sky dome and water reflections.
//   uRefl*     planar water reflection (reflection.js): on, water height, range; picture; world -> picture UV.
import * as THREE from 'three';

export const GLOBALS = {
  uViewPos: { value: new THREE.Vector3() },
  uCloud: { value: new THREE.Vector4(0.36, 3000, 0.55, 0) },   // coverage, layer height (m), shadow strength
  uSunDir: { value: new THREE.Vector3(-0.52, 0.67, 0.52).normalize() },
  uCloudTime: { value: 0 },
  uHorizon: { value: new THREE.Color(0.66, 0.75, 0.86) },   // humid horizon
  uZenith: { value: new THREE.Color(0.10, 0.25, 0.58) },
  uRefl: { value: new THREE.Vector4(0, 0, 4000, 0) },
  uReflMap: { value: null },
  uReflMatrix: { value: new THREE.Matrix4() },
};
