// Original An Giang tree forms. Units: metres, local Y up, root at ground.
// Shared atlas: fineTwig/narrowTwig sprays run along U; paleBark is opaque.
// Stems/branches use aPart=0, leaf sprays aPart=1. Materials stay in trees.js.

const add = (a, b) => a.map((v, i) => v + b[i]);
const mul = (a, k) => a.map(v => v * k);
const unit = a => { const n = Math.hypot(...a) || 1; return mul(a, 1 / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const tint = (a, k) => a.map(v => v * k);
const GOLDEN = 2.399963229728653;

// Keep the existing shade species' 15 m nominal height without widening its umbrella.
function verticalModel(Model, scaleY) {
  const m = new Model(), vert = m.vert;
  m.vert = function(p, n, ...rest) {
    return vert.call(this, [p[0], p[1] * scaleY, p[2]], unit([n[0], n[1] / scaleY, n[2]]), ...rest);
  };
  return m;
}

function builder(cells, uvRect) {
  const white = uvRect(cells.white);
  const rect = name => uvRect(cells[name] || cells.mangoTwig || cells.broadSide);
  const colourUV = [white[0] + white[2] * .5, white[1] + white[3] * .5];

  // Tapered bent tubes. Duplicated seam vertices keep bark UVs continuous.
  function limb(m, points, radii, colour, sides = 5, cell = 'white') {
    const uv = cell === 'white' ? white : rect(cell);
    const rings = points.map((p, k) => {
      const before = points[Math.max(0, k - 1)], after = points[Math.min(points.length - 1, k + 1)];
      const axis = unit(after.map((v, i) => v - before[i]));
      const u = unit(cross(axis, Math.abs(axis[1]) > .9 ? [1, 0, 0] : [0, 1, 0]));
      const v = cross(axis, u);
      return Array.from({ length: sides + 1 }, (_, j) => {
        const a = j / sides * Math.PI * 2, normal = add(mul(u, Math.cos(a)), mul(v, Math.sin(a)));
        const position=add(p, mul(normal, radii[k])); position[1]=Math.max(0,position[1]);
        return m.vert(position, normal,
          cell === 'white' ? colourUV : [uv[0] + uv[2] * j / sides, uv[1] + uv[3] * k / (points.length - 1)],
          0, tint(colour, .94 + .08 * Math.cos(a * 3 + k)));
      });
    });
    for (let k = 0; k < rings.length - 1; k++) for (let j = 0; j < sides; j++) {
      const a = rings[k][j], b = rings[k][j + 1], c = rings[k + 1][j + 1], d = rings[k + 1][j];
      m.idx.push(a, b, c, a, c, d);
    }
  }

  // Narrow branch/sheath ribbons are sufficient for small twigs and cheap outer LODs.
  function ribbon(m, points, widths, colour, plane = [0, 0, 1]) {
    const ids = points.map((p, k) => {
      const axis = unit(points[Math.min(points.length - 1, k + 1)].map((v, i) =>
        v - points[Math.max(0, k - 1)][i]));
      let across = unit(cross(axis, plane));
      if (Math.hypot(...across) < .5) across = [1, 0, 0];
      const normal = unit(cross(across, axis));
      return [-1, 1].map(sign => m.vert(add(p, mul(across, sign * widths[k] / 2)),
        normal, colourUV, 0, colour));
    });
    for (let k = 0; k < ids.length - 1; k++) m.idx.push(ids[k][0], ids[k][1], ids[k + 1][1],
      ids[k][0], ids[k + 1][1], ids[k + 1][0]);
  }

  // Photo leaflets sit on an original branch spray, rather than an entire tree billboard.
  // The base lies on the left end of the atlas petiole; geometry twigs reach inside it.
  function spray(m, base, length, width, az, elev, roll, cell, colour) {
    const u = [Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev)];
    const v = unit([-Math.sin(az) * Math.sin(roll), Math.cos(roll), Math.cos(az) * Math.sin(roll)]);
    const end = add(base, mul(u, length));
    const corners = [add(base, mul(v, -width / 2)), add(end, mul(v, -width / 2)),
      add(end, mul(v, width / 2)), add(base, mul(v, width / 2))];
    m.quadP(corners, rect(cell), p => unit([u[0] * .35, .72 + (p[1] - base[1]) * .16, u[2] * .35]),
      1, colour);
  }

  function crownSprays(m, tip, az, length, width, cell, colour, count = 3) {
    for (let j = 0; j < count; j++) {
      const a = az + (j - 1) * .62;
      const base = add(tip, [-Math.cos(a) * .18, .08 * j, -Math.sin(a) * .18]);
      spray(m, base, length * (1 - .10 * (j % 2)), width, a, .12 + j * .03,
        .28 + j * .49, cell, tint(colour, .88 + .07 * j));
    }
  }
  return { limb, ribbon, spray, crownSprays };
}


// Representative BÃƒÂ¡Ã‚ÂºÃ‚Â£y NÃƒÆ’Ã‚Âºi woodland, derived from the owner-approved Sam/CÃƒÂ¡Ã‚ÂºÃ‚Â¥m photos.
// These are shape categories, not a botanical species survey. Heights are photo estimates.
// Forking happens low on the bole; overlapping small twig sprays form uneven crown lobes.
const WOODLAND = [
  { id: 'forest', fork: 2.2, crown: 5.50, reach: 2.75, tilt: [.26, -.10], stretch: [1, 1], seed: .31 },
  { id: 'woodlandLobed', fork: 2.45, crown: 6.40, reach: 3.65, tilt: [-.38, .20], stretch: [1.10, .90], seed: 1.13 },
  { id: 'woodlandLean', fork: 2.8, crown: 8.05, reach: 3.10, tilt: [1.40, -.45], stretch: [.92, 1.08], seed: 2.03 },
];

export function hillWoodlandSpecies(x, north) {
  // Twenty-metre local patches avoid a tree-by-tree checkerboard; the same world coordinate
  // always chooses the same form, independent of chunk loading and near/mid generation.
  const a = Math.floor(x / 20), b = Math.floor(north / 20);
  const h = ((Math.imul(a ^ 0x61c88647, 374761393) ^ Math.imul(b, 668265263)) >>> 0) / 4294967296;
  return h < .44 ? 'forest' : h < .72 ? 'woodlandLobed' : h < .90 ? 'woodlandLean' : 'shrub';
}

function woodlandNearModels(Model, cells, uvRect) {
  const { limb, ribbon, spray } = builder(cells, uvRect), models = {};
  const wood = [.79, .76, .66], leaf = [.91, 1.01, .84];
  for (const form of WOODLAND) {
    const m = new Model(), branches = [], f = form.fork, cy = form.crown;
    const tx = form.tilt[0], tz = form.tilt[1];
    limb(m, [[0, 0, 0], [tx * .18, 1.05, tz * .18], [tx * .42, f, tz * .42],
      [tx * .64, f + 1.6, tz * .64]], [.32, .26, .205, .125], wood, 6, 'mangoBark');
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + .2;
      limb(m, [[Math.cos(a) * .70, .015, Math.sin(a) * .70], [tx * .15, .8, tz * .15]],
        [.045, .135], tint(wood, .93), 2, 'mangoBark');
    }
    for (let i = 0; i < 6; i++) {
      const az = i * GOLDEN + form.seed, r = form.reach * (.84 + (i % 3) * .105);
      const start = [tx * .43, f + (i % 3) * .30, tz * .43];
      const elbow = [tx * .68 + Math.cos(az) * r * .55, cy - 1.3 + (i % 2) * .4,
        tz * .68 + Math.sin(az) * r * .55];
      const tip = [tx + Math.cos(az) * r * form.stretch[0],
        cy + 1.08 * Math.sin(i * 2.4 + form.seed), tz + Math.sin(az) * r * form.stretch[1]];
      limb(m, [start, elbow, tip], [.13, .077, .026], wood, 4, 'mangoBark');
      branches.push([elbow, tip]);
      for (let j = 0; j < 2; j++) {
        const a = az + (j ? .72 : -.66);
        const end = add(tip, [Math.cos(a) * .78, .48 + .22 * j, Math.sin(a) * .78]);
        limb(m, [elbow, end], [.043, .010], wood, 3, 'mangoBark');
      }
      // Nine small irregular tufts around each branch end, not one crown-sized card.
      for (let k = 0; k < 9; k++) {
        const a = k * GOLDEN + i * .51, v = (k / 8 - .5) * 2;
        const rr = 1.55 * Math.sqrt(1 - v * v * .78);
        // Tufts occupy a lumpy three-dimensional crown, including lower hanging boughs.
        const p = add(tip, [Math.cos(a) * rr,
          1.40 * v + .22 * Math.sin(k * 1.63 + i), Math.sin(a) * rr]);
        for (let j = 0; j < 3; j++) {
          const q = a + j * 2.12 + .16 * Math.sin(i + k);
          const base = add(p, [-Math.cos(q) * .20, j * .055, -Math.sin(q) * .20]);
          spray(m, base, 1.95 + .17 * ((i + j + k) % 3), 1.62 + .15 * (k % 3), q,
            -.10 + .24 * j, .20 + j * .87, 'mangoTwig',
            tint(leaf, .82 + .05 * ((i * 3 + k + j) % 5)));
        }
      }
    }
    // Centre infill is higher and offset, so the lobes overlap without a level stacked roof.
    for (let k = 0; k < 7; k++) {
      const a = k * GOLDEN + form.seed, rr = .85 * Math.sqrt((k + 1) / 7);
      const p = [tx * .60 + Math.cos(a) * rr, cy + 1.02 + .60 * Math.sin(k * 1.8),
        tz * .60 + Math.sin(a) * rr];
      for (let j = 0; j < 3; j++) spray(m, p, 1.82, 1.63, a + j * 2.1,
        .17, .34 + j * .67, 'mangoTwig', tint(leaf, .89 + j * .04));
    }
    models[form.id] = m.geometry();
  }

  // Woody scrub reused for authored tourist shrubs as well as ten percent of mapped hill cover.
  // Several stems, low forks and ragged twig tufts replace the previous flat green clump.
  const shrub = new Model();
  for (let i = 0; i < 5; i++) {
    const a = i * GOLDEN, r = .12 + .18 * (i % 2), h = 1.35 + (i % 3) * .21;
    const tip = [Math.cos(a) * .48, h, Math.sin(a) * .48];
    limb(shrub, [[Math.cos(a) * r, 0, Math.sin(a) * r], [0, .65, 0], tip],
      [.065, .045, .015], [.65, .64, .53], 3, 'mangoBark');
    for (let k = 0; k < 8; k++) {
      const q = a + k * GOLDEN, rr = .55 * Math.sqrt((k + .5) / 8);
      const p = add(tip, [Math.cos(q) * rr, .10 + .17 * Math.sin(k), Math.sin(q) * rr]);
      for (let j = 0; j < 2; j++) spray(shrub, p, 1.02 + .08 * (k % 2), .92,
        q + j * 2.3, .20, .22 + j * .95, 'mangoTwig',
        tint([.86, .99, .76], .80 + .07 * ((i + k) % 4)));
    }
  }
  models.shrub = shrub.geometry();
  return models;
}

function woodlandOuterModels(Model, cells, uvRect) {
  // These silhouettes are baked from each exact near mesh, into unused cells of the same atlas.
  // Crossed side cards and the top view preserve low, uneven crowns for distant forest chunks.
  // Bark at the lower corners is rigid; only upper crown vertices get wind.
  const dimensions = {
    forest: ['woodlandRoundSide', 'woodlandRoundTop', 13, 9.3],
    woodlandLobed: ['woodlandLobedSide', 'woodlandLobedTop', 15, 10.4],
    woodlandLean: ['woodlandLeanSide', 'woodlandLeanTop', 15, 12.1],
    shrub: ['woodlandShrubSide', 'woodlandShrubTop', 4, 2.95],
  }, models = {};
  for (const [id, [side, top, w, h]] of Object.entries(dimensions)) {
    const m = new Model(), r = uvRect(cells[side]), col = [1, 1, 1];
    for (const a of [0, Math.PI / 2]) {
      const dx = Math.cos(a) * w / 2, dz = Math.sin(a) * w / 2;
      const c = [[-dx, 0, -dz], [dx, 0, dz], [dx, h, dz], [-dx, h, -dz]];
      const uv = [[r[0], r[1]], [r[0]+r[2], r[1]], [r[0]+r[2], r[1]+r[3]], [r[0], r[1]+r[3]]];
      const ix = c.map((p, j) => m.vert(p, unit([p[0]*.08, .80, p[2]*.08]), uv[j], j < 2 ? 0 : 1, col));
      m.idx.push(ix[0], ix[1], ix[2], ix[0], ix[2], ix[3]);
    }
    m.top(0, 0, w, h*.77, top, [0,h*.60,0], col);
    models[id] = m.geometry();
  }
  return models;
}

export function nextTreeModels(Model, cells, uvRect, bark) {
  const { limb, ribbon, spray, crownSprays } = builder(cells, uvRect);
  const bamboo = new Model(), shade = verticalModel(Model, 1.175), tram = new Model(), forest = new Model();
  const bambooWood = [.22, .36, .10], fineLeaf = [.80, .94, .72];
  const paleWood = [.92, .95, .85], darkWood = [.84, .79, .69];

  // Tre: 24 separate culms emerge from one tight mat and bow outward in their upper third.
  // Thin solid culms and two paired sprays each stay below the 1,500-triangle ceiling.
  for (let i = 0; i < 24; i++) {
    const a = i * GOLDEN, radius = .18 + .74 * Math.sqrt((i + 1) / 24);
    const base = [Math.cos(a) * radius, 0, Math.sin(a) * radius];
    const h = 11.2 + (i % 6) * .44, reach = 2.25 + (i % 4) * .36;
    const point = t => [base[0] + Math.cos(a) * reach * t * t,
      h * t - .90 * t * t * t, base[2] + Math.sin(a) * reach * t * t];
    const points = Array.from({ length: 7 }, (_, k) => point(k / 6));
    limb(bamboo, points, points.map((_, k) => .043 * (1 - .60 * k / 6)),
      tint(bambooWood, .9 + (i % 5) * .055), 4);
    for (let j = 0; j < 2; j++) {
      const p = point(j ? .94 : .70), side = a + (j ? -.52 : .48);
      const leafBase = add(p, [Math.cos(side) * .24, .08, Math.sin(side) * .24]);
      ribbon(bamboo, [p, add(leafBase, [Math.cos(side) * .22, .03, Math.sin(side) * .22])],
        [.025, .008], bambooWood);
      for (let q = 0; q < 2; q++) spray(bamboo, leafBase,
        1.45 + (i % 3) * .16, .80 - q * .08, side + q * .38, .12 - q * .24,
        .24 + q * .92, 'fineTwig', tint(fineLeaf, .88 + .05 * ((i + q) % 4)));
    }
    // Fill the upper-middle gap without adding more culms or a solid crown card.
    const mid = point(.83), midAz = a + 1.08;
    spray(bamboo, mid, 1.65, 1.02, midAz, .08, .72,
      'fineTwig', tint(fineLeaf, .91 + .035 * (i % 3)));
    if (i % 4 === 0) spray(bamboo, point(.91), 1.45, .98, a - 1.12, -.10, 1.05,
      'fineTwig', tint(fineLeaf, .87));
  }

  // CÃƒÆ’Ã‚Â²ng / me: low crotches lead into thick horizontal limbs and a wide, shallow umbrella.
  const shadeSegments = [];
  limb(shade, [[0, 0, 0], [.08, 1.1, .03], [-.12, 2.6, .08], [.05, 4.1, 0]],
    [.57, .46, .40, .27], darkWood, 7, 'mangoBark');
  for (let i = 0; i < 5; i++) {
    const a = i * Math.PI * 2 / 5;
    limb(shade, [[Math.cos(a) * 1.05, .03, Math.sin(a) * 1.05], [.02, 1.3, 0]],
      [.075, .20], darkWood, 4, 'mangoBark');
  }
  for (let i = 0; i < 7; i++) {
    const a = i * GOLDEN + .2, reach = 6.2 + (i % 3) * .40;
    const elbow = [Math.cos(a) * 2.7, 5.8 + (i % 2) * .4, Math.sin(a) * 2.7];
    const tip = [Math.cos(a) * reach, 8.65 + (i % 3) * .34, Math.sin(a) * reach];
    const start = [.02, 3.05 + (i % 3) * .25, 0];
    limb(shade, [start, elbow, tip], [.23, .14, .064], darkWood, 5, 'mangoBark');
    shadeSegments.push([start, elbow], [elbow, tip]);
    for (let j = 0; j < 3; j++) {
      const az = a + (j - 1) * .42;
      const end = [Math.cos(az) * (reach + .85), 9.75 + (i % 2) * .38 + j * .18,
        Math.sin(az) * (reach + .85)];
      limb(shade, [elbow, tip, end], [.070, .042, .016], darkWood, 4, 'mangoBark');
      shadeSegments.push([tip, end]);
      crownSprays(shade, end, az, 2.5, 1.28, 'fineTwig', [.77, .92, .72]);
    }
  }
  for (let i = 0; i < 7; i++) {
    const a = i * GOLDEN, tip = [Math.cos(a) * 2.1, 11.55 + (i % 2) * .32, Math.sin(a) * 2.1];
    limb(shade, [[0, 4, 0], tip], [.080, .020], darkWood, 4, 'mangoBark');
    crownSprays(shade, tip, a, 2.15, 1.35, 'fineTwig', [.83, .97, .77]);
    shadeSegments.push([[0, 4, 0], tip]);
  }


  // Fine foliage fills the shallow umbrella between its structural branches.
  // Sixty irregular tufts each use four twig sprays and one connected thin twig (600 tris).
  // These sit within the existing crown outline and retain its original height and limbs.
  for (let i = 0; i < 60; i++) {
    const a = i * GOLDEN + .19 * Math.sin(i * 1.71);
    const r = 6.30 * Math.sqrt((i + .5) / 60);
    const anchor = [Math.cos(a) * r, 9.75 + .85 * (1 - r / 6.3) + .18 * Math.sin(i * 2.3),
      Math.sin(a) * r];
    let join = null, nearest = Infinity;
    for (const [start, end] of shadeSegments) {
      const axis = end.map((v, k) => v - start[k]);
      const offset = anchor.map((v, k) => v - start[k]);
      const t = Math.max(0, Math.min(1, offset.reduce((sum, v, k) => sum + v * axis[k], 0) /
        axis.reduce((sum, v) => sum + v * v, 0)));
      const p = add(start, mul(axis, t));
      const distance = Math.hypot(...anchor.map((v, k) => v - p[k]));
      if (distance < nearest) { nearest = distance; join = p; }
    }
    ribbon(shade, [join, anchor], [.018, .003], tint(darkWood, .84));
    for (let j = 0; j < 4; j++) {
      const az = a + j * 1.55 + .20 * Math.sin(i + j);
      const base = add(anchor, [-Math.cos(az) * .22, j * .035, -Math.sin(az) * .22]);
      spray(shade, base, 2.40 + .12 * ((i + j) % 3), 2.10 + .12 * (i % 3), az,
        .08 + .035 * (j % 3), .35 + .40 * (j % 3), 'fineTwig',
        tint([.80, .95, .75], .88 + .045 * ((i + j) % 4)));
    }
  }

  // TrÃƒÆ’Ã‚Â m / bÃƒÂ¡Ã‚ÂºÃ‚Â¡ch Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â n: a pale narrow bole remains visible through an open, wispy upper crown.
  const tramStem = [[0, 0, 0], [.08, 3.2, -.04], [.22, 6.8, .05], [.58, 10.3, .14], [.87, 13.15, .19]];
  limb(tram, tramStem, [.18, .15, .12, .078, .028], paleWood, 7, 'paleBark');
  for (let i = 0; i < 14; i++) {
    const a = i * GOLDEN, y = 7.05 + (i % 7) * .76;
    const start = [.22 + Math.max(y - 6.8, 0) * .1, y, .08];
    const reach = .70 + (i % 4) * .27;
    const tip = [start[0] + Math.cos(a) * reach, y + 1.35 + (i % 2) * .25,
      start[2] + Math.sin(a) * reach];
    limb(tram, [start, add(start, [Math.cos(a) * reach * .55, .65, Math.sin(a) * reach * .55]), tip],
      [.045, .027, .009], paleWood, 4, 'paleBark');
    crownSprays(tram, tip, a, 1.25 + (i % 3) * .13, .77, 'narrowTwig', [.83, .97, .81], 2);
    if (i % 2 === 0) {
      const end = add(tip, [Math.cos(a + .7) * .56, .3, Math.sin(a + .7) * .56]);
      limb(tram, [tip, end], [.015, .006], paleWood, 3, 'paleBark');
      spray(tram, end, 1.02, .66, a + .7, .22, .78, 'narrowTwig', [.82, .94, .78]);
    }
  }
  for (let i = 0; i < 6; i++) {
    const a = i * 1.8, y = 1.5 + i * 1.48, r = .16 - i * .012;
    ribbon(tram, [[Math.cos(a) * r, y + .65, Math.sin(a) * r],
      [Math.cos(a) * (r + .025), y + .25, Math.sin(a) * (r + .025)],
      [Math.cos(a) * (r + .09), y - .35, Math.sin(a) * (r + .09)]],
      [.055, .060, .013], [.56, .52, .41], [Math.cos(a), 0, Math.sin(a)]);
  }
  crownSprays(tram, tramStem.at(-1), .35, 1.15, .80, 'narrowTwig', [.87, 1.0, .84], 3);

  // DÃƒÂ¡Ã‚ÂºÃ‚Â§u / sao-like representative retained for explicit tall planted trees, not blanket hill cover.
  // A nearly straight bole and buttressed roots; crown begins well above the ground.
  const forestStem = [[0, 0, 0], [.03, 3, .04], [.09, 10, -.03], [.15, 17, .08], [.24, 21.5, .07]];
  limb(forest, forestStem, [.46, .35, .27, .19, .065], [.85, .87, .79], 8, 'paleBark');
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + .25;
    limb(forest, [[Math.cos(a) * 1.15, .025, Math.sin(a) * 1.15],
      [Math.cos(a) * .43, .9, Math.sin(a) * .43], [.02, 2.25, 0]],
      [.055, .135, .21], [.76, .78, .70], 4, 'paleBark');
  }
  for (let i = 0; i < 9; i++) {
    const a = i * GOLDEN, y = 17.75 + (i % 4) * 1.03;
    const start = [.14, y, .08], reach = 1.6 + (i % 3) * .52;
    const elbow = [Math.cos(a) * reach * .56, y + 1.35, Math.sin(a) * reach * .56];
    const tip = [Math.cos(a) * reach, y + 2.05, Math.sin(a) * reach];
    limb(forest, [start, elbow, tip], [.095, .058, .018], [.83, .85, .75], 5, 'paleBark');
    for (let j = 0; j < 2; j++) {
      const az = a + (j ? .55 : -.38), end = add(tip, [Math.cos(az) * .46, .36, Math.sin(az) * .46]);
      limb(forest, [elbow, end], [.033, .010], [.83, .85, .75], 4, 'paleBark');
      crownSprays(forest, end, az, 1.65 + (i % 2) * .18, 1.18, 'mangoTwig', [.84, .99, .80], 3);
    }
  }
  crownSprays(forest, [0, 24, 0], .7, 1.50, 1.1, 'mangoTwig', [.91, 1.04, .84], 3);
  void bark; // Shared palette argument retained for the same builder API as round one.
  return { bamboo: bamboo.geometry(), shade: shade.geometry(), tram: tram.geometry(),
    dau: forest.geometry(), ...woodlandNearModels(Model, cells, uvRect) };
}

// Outer trees keep each species' culms, umbrella, open narrow crown or high canopy.
// No full tree sprite or round crown disc; only a few individual twig/leaf cards.
export function outerTreeModels(Model, cells, uvRect, bark) {
  const { limb, ribbon, spray } = builder(cells, uvRect);
  const bamboo = new Model(), shade = verticalModel(Model, 1.145), tram = new Model(), forest = new Model();

  for (let i = 0; i < 6; i++) {
    const a = i * GOLDEN, h = 11.2 + (i % 3) * .6;
    const base = [Math.cos(a) * .55, 0, Math.sin(a) * .55];
    const elbow = [Math.cos(a) * 1.1, h * .61, Math.sin(a) * 1.1];
    const tip = [Math.cos(a) * 3.2, h, Math.sin(a) * 3.2];
    ribbon(bamboo, [base, elbow, tip], [.095, .065, .030], [.24, .38, .12]);
    spray(bamboo, add(tip, [-Math.cos(a) * .2, -.05, -Math.sin(a) * .2]),
      1.7, 1.5, a + .14, .05, .65, 'fineTwig', [.82, .96, .72]);
  }
  for (let i = 0; i < 2; i++) spray(bamboo,
    [i ? -1.2 : 1.4, 8.4 + i * 1.8, i ? .8 : -.7], 2.0, 1.55,
    i * 2.1, .12, .4, 'fineTwig', [.78, .94, .68]);

  limb(shade, [[0, 0, 0], [-.1, 2.6, .1], [0, 4.1, 0]], [.56, .37, .22], [.52, .44, .33], 3);
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3 + .2;
    ribbon(shade, [[0, 3.4, 0], [Math.cos(a) * 3.3, 6.2, Math.sin(a) * 3.3],
      [Math.cos(a) * 7.4, 9.3, Math.sin(a) * 7.4]], [.34, .20, .075], [.50, .43, .33]);
  }
  for (let i = 0; i < 8; i++) {
    const a = i * GOLDEN, r = i < 6 ? 6.65 : 1.8, y = i < 6 ? 9.6 + (i % 3) * .36 : 11.6;
    spray(shade, [Math.cos(a) * r, y, Math.sin(a) * r], 3.1, 2.4, a,
      .11, .24 + (i % 3) * .43, 'fineTwig', [.78, .94, .73]);
  }

  limb(tram, [[0, 0, 0], [.22, 6.8, .05], [.86, 13.15, .19]], [.18, .12, .025], [.92, .95, .85], 3, 'paleBark');
  for (let i = 0; i < 2; i++) {
    const a = i * 2.7 + .3, y = 8.3 + i * 1.6;
    ribbon(tram, [[.3, y, .1], [Math.cos(a) * .8 + .3, y + .9, Math.sin(a) * .8],
      [Math.cos(a) * 1.2 + .3, y + 1.5, Math.sin(a) * 1.2]], [.055, .030, .010], [.83, .87, .77]);
  }
  for (let i = 0; i < 5; i++) {
    const a = i * GOLDEN, y = 9.2 + i * .75;
    spray(tram, [Math.cos(a) * .85 + .45, y, Math.sin(a) * .85],
      1.4, 1.25, a, .15, .2 + (i % 3) * .4, 'narrowTwig', [.84, .97, .81]);
  }

  limb(forest, [[0, 0, 0], [.21, 21.5, .07]], [.45, .095], [.85, .87, .79], 4, 'paleBark');
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3, y = 18.5 + (i % 2) * 1.5;
    ribbon(forest, [[.15, y, .05], [Math.cos(a) * 1.1, y + 1.25, Math.sin(a) * 1.1],
      [Math.cos(a) * 2.3, y + 2.8, Math.sin(a) * 2.3]], [.14, .080, .025], [.83, .85, .75]);
  }
  for (let i = 0; i < 10; i++) {
    const a = i * GOLDEN, r = i < 7 ? 1.7 : .35, y = 20.8 + (i % 4) * .91;
    spray(forest, [Math.cos(a) * r, y, Math.sin(a) * r], 2.0, 1.8,
      a, .22, .25 + (i % 3) * .4, 'mangoTwig', [.85, 1.0, .81]);
  }
  void bark;
  return { bamboo: bamboo.geometry(), shade: shade.geometry(), tram: tram.geometry(),
    dau: forest.geometry(), ...woodlandOuterModels(Model, cells, uvRect) };
}
