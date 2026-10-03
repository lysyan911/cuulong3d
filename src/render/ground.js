// CC0 ground photographs for the terrain close up (Codex's pack in web/textures/ground, credits in meta.json).
//
// The colour and normal maps are packed into two texture arrays (one layer per surface, 512 px: a few mm per texel at
// 2-3 m per tile), so the terrain shader needs only two extra texture units. Each layer's average colour is measured
// here, so the shader can lay the photo's detail over the satellite colour without changing the map's tones.
// Layers: 0 wet mud, 1 dry cracked mud, 2 grass, 3 dirt, 4 granite, 5 young rice (mud normals).
import * as THREE from 'three';

const LAYERS = [                  // [file base, metres per tile, normal-map base]
  ['brown_mud', 2], ['mud_cracked_dry_03', 2], ['grass_ground', 3], ['dirt', 3.5], ['tiger_rock', 6],
  ['young-rice', 2, 'brown_mud'],
];
const SIZE = 512;

function placeholder() {
  const t = new THREE.DataArrayTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, 1);
  t.needsUpdate = true;
  return t;
}

export const GROUND = {
  uGround: { value: placeholder() },
  uGroundN: { value: placeholder() },
  uGroundMean: { value: LAYERS.map(() => new THREE.Vector3(0.2, 0.2, 0.2)) },
  uGroundTile: { value: LAYERS.map((l) => l[1]) },
  uGroundOn: { value: 0 },
};

async function pixels(url) {
  const img = await createImageBitmap(await (await fetch(url)).blob());
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SIZE, SIZE)
    : Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  img.close?.();
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

function arrayTexture(data, srgb) {
  const t = new THREE.DataArrayTexture(data, SIZE, SIZE, LAYERS.length);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Load the photos (about 1 s, after the map is up); the terrain switches them on when ready. */
export async function loadGround(base = 'textures/ground/') {
  const layer = SIZE * SIZE * 4;
  const col = new Uint8Array(layer * LAYERS.length), nrm = new Uint8Array(layer * LAYERS.length);
  await Promise.all(LAYERS.map(async ([id, , nid], i) => {
    const [c, n] = await Promise.all([pixels(`${base}${id}-color.webp`), pixels(`${base}${nid || id}-normal.webp`)]);
    col.set(c, i * layer);
    nrm.set(n, i * layer);
    const m = GROUND.uGroundMean.value[i].set(0, 0, 0);       // linear average colour
    let k = 0;
    for (let p = 0; p < c.length; p += 4 * 37, k++) m.x += (c[p] / 255) ** 2.2, m.y += (c[p + 1] / 255) ** 2.2, m.z += (c[p + 2] / 255) ** 2.2;
    m.multiplyScalar(1 / k);
  }));
  GROUND.uGround.value = arrayTexture(col, true);
  GROUND.uGroundN.value = arrayTexture(nrm, false);
  GROUND.uGroundOn.value = 1;
}
