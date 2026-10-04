// Mekong building kit (Codex, web/models/kit): reusable An Giang building models that houses.js puts on real footprints
// near the viewer (shophouses, rural tin / tile / 3-gian houses, stilt and Khmer houses, factories, warehouses, mills).
// Each model is reflowed to its footprint in the vertex shader, following the kit's stretch contract (kit README):
//   spans (walls, roofs) scale between metric insets, rigid parts (doors, fronts, huts) move to anchors (fractions of
//   W / D), repeated modules (side windows, stilt bays, portal bays) are re-spaced; copies beyond the count collapse.
// So one instanced draw per model per block. Height never stretches. Plaster and tin take each house's own colours.
import * as THREE from 'three';
import { cloudUniforms, patchCloudShadow } from './render/atmosphere.js';

const BASE = 'models/kit/';
const MODE = { fixed: 0, span: 1, anchor: 2, repeat: 3 };
const GLASS = 1, FILL = 2, ANCHORED = 4;                 // flags

// ---------------------------------------------------------------- GLB reading (float attributes, ushort indices)
async function readGlb(url) {
  const buf = await fetch(url).then((r) => { if (!r.ok) throw new Error(url); return r.arrayBuffer(); });
  const dv = new DataView(buf), jsonLen = dv.getUint32(12, true);
  const g = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8;
  const acc = (i) => {
    const a = g.accessors[i], bv = g.bufferViews[a.bufferView], off = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0);
    const n = a.count * { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type];
    return a.componentType === 5126 ? new Float32Array(buf.slice(off, off + n * 4))
         : a.componentType === 5123 ? new Uint16Array(buf.slice(off, off + n * 2)) : new Uint32Array(buf.slice(off, off + n * 4));
  };
  const parts = [];
  for (const nd of g.nodes) {
    if (nd.mesh === undefined) continue;
    const meta = nd.extras?.kit ? JSON.parse(nd.extras.kit) : {};
    for (const p of g.meshes[nd.mesh].primitives) {
      const pos = acc(p.attributes.POSITION);
      parts.push({ meta, t: nd.translation || [0, 0, 0], pos, uv: acc(p.attributes.TEXCOORD_0),
                   idx: p.indices !== undefined ? acc(p.indices) : null,
                   glass: /glass/.test(g.materials[p.material]?.name || '') });
    }
  }
  return parts;
}

// one geometry with per-vertex reflow data; repeated modules duplicated up to maxD
function reflowGeometry(parts, maxD) {
  const P = [], UV = [], T = [], M = [], S = [], R = [], I = [];
  let base = 0;
  const groups = {};
  for (const p of parts) if (p.meta.repeat) (groups[p.meta.repeat.group] ||= []).push(p);
  const add = (p, mode, xf, zf, flags, span, copy) => {
    const n = p.pos.length / 3;
    for (let k = 0; k < n; k++) {
      P.push(p.pos[k * 3], p.pos[k * 3 + 1], p.pos[k * 3 + 2]);
      UV.push(p.uv[k * 2], p.uv[k * 2 + 1]);
      T.push(...p.t); M.push(mode, xf, zf, flags | (p.glass ? GLASS : 0)); S.push(...span); R.push(copy);
    }
    if (p.idx) for (const i of p.idx) I.push(base + i);
    else for (let i = 0; i < n; i++) I.push(base + i);
    base += n;
  };
  for (const p of parts) {
    const m = p.meta;
    if (m.repeat) continue;
    if (m.anchor) add(p, MODE.anchor, m.anchor.x_fraction, m.anchor.z_fraction, 0, [0, 0, 0, 0], 0);
    else if (m.scale_spans) {
      const x = m.scale_spans.x, z = m.scale_spans.z;
      add(p, MODE.span, 0, 0, 0, [x ? x.reference : 0, x ? x.left_inset + x.right_inset : 0,
                                  z ? z.reference : 0, z ? z.front_inset + z.back_inset : 0], 0);
    } else add(p, MODE.fixed, 0, 0, 0, [0, 0, 0, 0], 0);
  }
  for (const ps of Object.values(groups)) {
    const proto = ps.reduce((a, b) => (b.meta.repeat.index < a.meta.repeat.index ? b : a));
    const r = proto.meta.repeat, a = proto.meta.anchor;
    const maxN = Math.max(1, Math.floor((maxD - r.front_inset - r.back_inset) / r.pitch + 0.5));
    const flags = (r.scale_to_spacing ? FILL : 0) | (a ? ANCHORED : 0);
    for (let j = 0; j < maxN; j++)
      add(proto, MODE.repeat, a ? a.x_fraction : 0, 0, flags, [r.pitch, r.front_inset, r.back_inset, r.reference_spacing || r.pitch], j);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(T, 3));
  geo.setAttribute('aMode', new THREE.Float32BufferAttribute(M, 4));
  geo.setAttribute('aSpan', new THREE.Float32BufferAttribute(S, 4));
  geo.setAttribute('aRep', new THREE.Float32BufferAttribute(R, 1));
  geo.setIndex(I);
  return geo;
}

// ---------------------------------------------------------------- material
const VERT_HEAD = /* glsl */`
attribute vec3 aT;
attribute vec4 aMode;    // mode, x fraction, z fraction, flags (1 glass, 2 fill the bay, 4 anchored repeat)
attribute vec4 aSpan;    // span: ref x, insets x, ref z, insets z | repeat: pitch, front inset, back inset, ref spacing
attribute float aRep;
attribute vec4 iA;       // x, ground y, z, front angle (as houses.js)
attribute vec3 iB;       // W, D (kit size for this house), H
attribute vec4 iC;       // style, roof kind, seed, hidden
attribute vec3 iRoof;
attribute vec3 iWall;
uniform vec3 uViewPos;
uniform float uKitNear, uNearR;
varying vec3 vKitWall, vKitRoof;
varying float vKitGlass;
`;
const VERT_BODY = /* glsl */`
  float W = iB.x, D = iB.y, flags = aMode.w;
  int mode = int(aMode.x + 0.5);
  bool gone = false;
  vec3 lp = aT + position;
  if (mode == 1) {
    lp = aT + position * vec3(aSpan.x > 0.0 ? (W - aSpan.y) / aSpan.x : 1.0, 1.0, aSpan.z > 0.0 ? (D - aSpan.w) / aSpan.z : 1.0);
  } else if (mode == 2) {
    lp = vec3(aMode.y * W, aT.y, aMode.z * D) + position;
  } else if (mode == 3) {
    float usable = D - aSpan.y - aSpan.z, n = max(1.0, floor(usable / aSpan.x + 0.5)), sp = usable / n;
    gone = aRep > n - 0.5;
    float fill = mod(flags, 4.0) > 1.5 ? sp / aSpan.w : 1.0;
    lp = vec3(flags > 3.5 ? aMode.y * W : aT.x, aT.y, D * 0.5 - aSpan.y - (aRep + 0.5) * sp) + position * vec3(1.0, 1.0, fill);
  }
  float dist = distance(uViewPos, iA.xyz);
#ifdef KIT_NEAR
  gone = gone || dist > uKitNear;
#else
  gone = gone || dist <= uKitNear || dist > uNearR;
#endif
  gone = gone || (iC.w > 0.5 && iC.w < 3.5);              // replaced by a detailed model, under a landmark, on water
  float c = cos(iA.w), s = sin(iA.w);
  vec3 transformed = iA.xyz + vec3(-s * lp.x + c * lp.z, lp.y + 0.3, -c * lp.x - s * lp.z);
  if (gone) transformed = vec3(0.0);
  vKitWall = iWall; vKitRoof = iRoof;
  vKitGlass = mod(flags, 2.0);
`;
const FRAG_HEAD = /* glsl */`
varying vec3 vKitWall, vKitRoof;
varying float vKitGlass;
vec3 kitLin(vec3 c) { return pow(c / 255.0, vec3(2.2)); }
`;
// atlas cells are 256 px; row 0 cols 0-4: plaster (cream, gray, blue, mint, yellow); tin: (0,1) gray, (1,1) blue, (4,3) green
const FRAG_TINT = /* glsl */`
  {
    vec2 cell = floor(vMapUv * vec2(8.0, 4.0));
    vec3 wallC = pow(vKitWall, vec3(2.2)), roofC = pow(vKitRoof, vec3(2.2));
    float wl = dot(wallC, vec3(0.2126, 0.7152, 0.0722)), rl = dot(roofC, vec3(0.2126, 0.7152, 0.0722));
    wallC = mix(vec3(wl), wallC, 0.55) * 0.88;              // the same weathering as the generated houses
    roofC = mix(vec3(rl), roofC, 0.62) * 0.85;
    if (cell.y < 0.5 && cell.x < 4.5) {
      vec3 m = cell.x < 0.5 ? kitLin(vec3(214, 212, 187)) : cell.x < 1.5 ? kitLin(vec3(184, 188, 182))
             : cell.x < 2.5 ? kitLin(vec3(136, 175, 187)) : cell.x < 3.5 ? kitLin(vec3(158, 190, 167)) : kitLin(vec3(213, 198, 144));
      diffuseColor.rgb *= clamp(wallC / m, vec3(0.25), vec3(2.5));
    } else if ((cell.y > 0.5 && cell.y < 1.5 && cell.x < 1.5) || (cell.y > 2.5 && cell.x > 3.5 && cell.x < 4.5)) {
      vec3 m = cell.y > 2.5 ? kitLin(vec3(64, 111, 103)) : cell.x < 0.5 ? kitLin(vec3(153, 167, 166)) : kitLin(vec3(56, 112, 144));
      diffuseColor.rgb *= clamp(roofC / m, vec3(0.25), vec3(3.0));
    }
  }
`;

function kitMaterial(lod, uniforms, atlas) {
  const mat = new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.82, metalness: 0, flatShading: true });
  mat.defines = { [lod]: '' };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <begin_vertex>', VERT_BODY);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + FRAG_TINT)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vKitGlass > 0.5 ? 0.3 : 0.82;');
    patchCloudShadow(sh, cloudUniforms());
  };
  mat.customProgramCacheKey = () => 'cuulong-kit-' + lod;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.defines = { [lod]: '' };
  depth.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <begin_vertex>', VERT_BODY);
  };
  depth.customProgramCacheKey = () => 'cuulong-kit-depth-' + lod;
  mat.userData.depthMaterial = depth;
  return mat;
}

// ---------------------------------------------------------------- the kit
const TUBE = 0, BLOCK = 1, GABLE = 2, HIP = 3, STILT = 4, KHMER = 5, HALL = 6;
const TIN = 0, CLAY = 1;

export class BuildingKit {
  /** uniforms: shared with houses.js (uViewPos, uNearR); kitNear: detailed models within this distance (m). */
  constructor(uniforms, kitNear = 350) {
    this.uniforms = { ...uniforms, uKitNear: { value: kitNear } };
    this.models = [];
    this.byId = {};
    this.ready = false;
  }

  async load(surface = null) {
    this.surface = surface;
    const kit = await fetch(BASE + 'kit.json').then((r) => r.json());
    const atlas = new THREE.TextureLoader().load(BASE + kit.atlas.file);
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.flipY = false;
    atlas.anisotropy = 4;
    this.matNear = kitMaterial('KIT_NEAR', this.uniforms, atlas);
    this.matFar = kitMaterial('KIT_FAR', this.uniforms, atlas);
    await Promise.all(kit.models.map(async (m, i) => {
      const range = m.stretch_range, maxD = range.depth[1] * 1.15;
      const [near, far] = await Promise.all([readGlb(BASE + m.near.file), readGlb(BASE + m.far.file)]);
      this.models[i] = { id: m.id, type: m.type, ref: m.reference, range, xs: m.stretchable_axes.includes('x'),
                         near: reflowGeometry(near, maxD), far: reflowGeometry(far, maxD) };
      this.byId[m.id] = i;
    }));
    this.ready = true;
  }

  /**
   * Which kit model (index + 1, 0 = keep the generated house) fits a house, and its kit size [W, D].
   * style / kind as houses.py; W front width, D depth, H eaves height (m); x, yN position for the shore test.
   */
  choose(style, kind, W, D, H, seed, x, yN) {
    const pick = (ids) => {                                  // the widest that still fits the plot
      let best = -1, bd = 1e9;
      for (const id of ids) {
        const k = this.byId[id], m = this.models[k], dw = m.ref.width > W + 1.0 ? 1e6 : W - m.ref.width;
        if (dw < bd) { bd = dw; best = k; }
      }
      return best;
    };
    const fit = (k, maxDW) => {
      if (k < 0) return null;
      const m = this.models[k], r = m.range;
      if (!m.xs && (m.ref.width > W + 1.0 || m.ref.width < W - maxDW)) return null;   // never much wider than the plot
      if (D < r.depth[0] * 0.85 - 1 || D > r.depth[1] * 1.6) return null;
      const w = m.xs ? Math.min(Math.max(W, 3.2), 7) : m.ref.width;
      return [k + 1, w, Math.min(Math.max(D, r.depth[0] * 0.85), Math.min(D + 0.5, r.depth[1] * 1.15))];
    };
    if (style === TUBE) {
      if (W > 7 || W < 3) return null;
      const fl = Math.round((H - 0.4) / 3.4);
      const id = fl <= 1 ? 'tube-01-shop' : fl === 2 ? 'tube-02-balcony' : fl === 3 ? 'tube-03-tiled' : fl === 4 ? 'tube-04-terrace' : null;
      return id ? fit(this.byId[id], 99) : null;
    }
    if (style === GABLE || style === HIP) {
      if (kind === TIN) return fit(pick(['rural-tin-01', 'rural-tin-02']), 2.5);
      if (kind === CLAY) return fit(pick(W >= 10.4 ? ['traditional-3gian-01', 'traditional-3gian-02'] : ['rural-tile-01', 'rural-tile-02']), 2.5);
      return null;                                           // thatch, concrete, glazed villas: generated
    }
    if (style === STILT) return fit(this.byId[kind === CLAY ? 'canal-stilt-02' : 'canal-stilt-01'], 2.5);
    if (style === KHMER) return fit(this.byId[kind === CLAY ? 'khmer-house-01' : 'khmer-house-02'], 2.5);
    if (style === HALL) {
      if (W < 10 || D < 18) return null;
      const shore = this.surface ? this.surface.shoreAt(x, yN) : 999;
      const id = shore < 45 ? (seed < 0.6 ? 'warehouse-canal-01' : 'rice-mill-01')
               : D >= 40 ? (seed < 0.5 ? 'factory-portal-01' : 'warehouse-rice-01')
               : seed < 0.4 ? 'warehouse-rice-01' : seed < 0.7 ? 'rice-mill-01' : seed < 0.85 ? 'market-hall-01' : 'factory-portal-01';
      return fit(this.byId[id], 8);
    }
    return null;
  }
}
