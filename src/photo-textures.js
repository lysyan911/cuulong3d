// Shared CC0 photo maps. Ground maps are deliberately not loaded here: terrain is Claude's layer.
import * as THREE from 'three';

const loader = new THREE.TextureLoader(), cache = new Map();
export const photoInventory = { images: 0, mipBytes: 0, files: [] };

export function photoTexture(file, { linear = false, repeat = false } = {}) {
  const key = `${file}:${linear}:${repeat}`;
  if (cache.has(key)) return cache.get(key);
  const texture = loader.load(`textures/${file}`, () => {
    photoInventory.images++;
    photoInventory.mipBytes += texture.image.width * texture.image.height * 4 * 4 / 3;
    photoInventory.files.push(file);
  }, undefined, e => console.warn('CC0 photo texture unavailable', file, e));
  texture.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;
  cache.set(key, texture);
  return texture;
}

export function photoMaps(group, id) {
  const base = `${group}/${id}`;
  return {
    map: photoTexture(`${base}-color.webp`, { repeat: true }),
    normalMap: photoTexture(`${base}-normal.webp`, { linear: true, repeat: true }),
    normalScale: new THREE.Vector2(.35, .35),
    roughnessMap: photoTexture(`${base}-roughness.webp`, { linear: true, repeat: true }),
  };
}

/** Metric planar UVs per triangle. Split seams so hard-surface Blender parts merge reliably. */
export function metricUVs(geometry, metres = 2) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const p = g.attributes.position, uv = new Float32Array(p.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    n.crossVectors(b.sub(a), c.sub(a));
    const x = Math.abs(n.x), y = Math.abs(n.y), z = Math.abs(n.z);
    for (let j = i; j < i + 3; j++) {
      uv[j * 2] = (x > y && x > z ? p.getZ(j) : p.getX(j)) / metres;
      uv[j * 2 + 1] = (y >= x && y >= z ? p.getZ(j) : p.getY(j)) / metres;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// Preserve trim, signs, flags, painted eyes, glass and small fittings.
export function modelPhotoMaterial(material, id) {
  const name = material.name;
  const wood = /^(wood(_dark|_light)?|timber_dark|timber_light|weathered_wood|hull_(grey|dark|light))$/.test(name);
  const tile = /^(old_tile(_dark|_light)?|roof_red|terracotta|porch_tile)$/.test(name);
  const tin = /^(awning_sheet|roof_metal)$/.test(name);
  const plaster = /^(plaster|cream|concrete|civic_white|urban_blue)$/.test(name);
  const asset = wood ? 'wooden_rough_planks' : tile ? 'clay_roof_tiles' : tin ? 'corrugated_iron'
              : plaster ? 'worn_plaster_wall' : null;
  if (!asset) return material;
  const mat = material.clone();
  Object.assign(mat, photoMaps('models', asset));
  // Donor albedo retains its colour; paint colours modulate the photograph.
  if (wood && /^(wood|weathered_wood|timber_light|hull_light)$/.test(name)) mat.color.setHex(0xd6cec0);
  if (tile) mat.color.lerp(new THREE.Color(0xffffff), .65);
  mat.roughness = tin ? .75 : 1;
  mat.userData.photoSource = asset;
  return mat;
}
