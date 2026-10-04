// Cửu Long 3D Map — three.js viewer. Data comes from scripts/export_web.py (web/data/).
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { Terrain } from './terrain.js';
import { SurfaceMap } from './surface.js';
import { PaddyLayer } from './paddies.js';
import { WetlandMap } from './wetland-map.js';
import { TraSuLayer } from './trasu.js';
import { StreamedImagery } from './imagery.js';
import { RoadLayer, buildLandmarks } from './world.js';
import { TreeLayer } from './trees.js';
import { HouseLayer } from './houses.js';
import { Road3DLayer } from './roads3d.js';
import { StreetFurniture } from './streets.js';
import { YardLayer } from './yards.js';
import { BuildingKit } from './kit.js';
import { OcclusionCuller } from './render/occlusion.js';
import { PropsLayer } from './props.js';
import { Overlays } from './overlays.js';
import { UI, NOVEL_LAYERS } from './ui.js';
import { photoInventory } from './photo-textures.js';
import { GLOBALS } from './render/globals.js';
import { skyMaterial, cloudUniforms, installAerialHaze } from './render/atmosphere.js';
import { SunShadows } from './render/shadows.js';
import { RenderPipeline } from './render/pipeline.js';
import { WaterReflection } from './render/reflection.js';
import { loadGround } from './render/ground.js';
import { initAnalytics, track } from './analytics.js';

const DATA = 'data/';
const MOBILE = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
const QUALITY = MOBILE
  ? { pixelRatio: 1, treeDist: 3500, treeNear: 500, roadRibbon: 2000, buildingDist: 7000, houseNear: 900, roadScale: 0.6, lodBias: 1, maxDetail: 4 }
  : { pixelRatio: Math.min(devicePixelRatio, 1.5), treeDist: 8000, treeNear: 1000, roadRibbon: 4000, buildingDist: 14000, houseNear: 1200, roadScale: 1, lodBias: 0,
      maxDetail: 10 };

const getJSON = (f) => fetch(DATA + f).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });

async function main() {
  installAerialHaze();
  // ---------------------------------------------------------------- renderer, scene, camera
  const container = document.getElementById('viewport');
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(QUALITY.pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  container.append(renderer.domElement);
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(innerWidth, innerHeight);
  Object.assign(labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
  container.append(labelRenderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 5, 700000);
  const controls = new MapControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, screenSpacePanning: false, maxPolarAngle: 1.54,
                            minDistance: 25, maxDistance: 320000, zoomToCursor: true });

  // ---------------------------------------------------------------- sky, sun, haze (render/atmosphere.js)
  // Afternoon sun from the south-west; one drifting cloud layer that both fills the sky and shades the ground.
  const HORIZON = GLOBALS.uHorizon.value, ZENITH = GLOBALS.uZenith.value;
  const sunDir = GLOBALS.uSunDir.value;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400000, 48, 24), skyMaterial(cloudUniforms(), { horizon: HORIZON, zenith: ZENITH }));
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.userData.noShadow = true;
  scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = skyMaterial(cloudUniforms(), { horizon: HORIZON, zenith: ZENITH });
  envSky.uniforms.uClouds.value = 0;                       // smooth sky light for the environment
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), envSky));
  scene.environment = pmrem.fromScene(envScene, 0, 1, 2000).texture;
  scene.environmentIntensity = 0.42;
  const sun = new THREE.DirectionalLight(0xffeedd, 3.4);
  sun.position.copy(sunDir).multiplyScalar(100000);
  scene.add(sun, sun.target, new THREE.HemisphereLight(0xc4dcff, 0x6a6146, 0.42));
  const HAZE = 0.65e-4;   // humid delta air: sea-level haze extinction per m (render/atmosphere.js installAerialHaze)
  scene.fog = new THREE.FogExp2(HORIZON.clone(), HAZE);
  const shadows = new SunShadows(renderer, sun, sunDir);
  const reflection = new WaterReflection(renderer, scene);
  // hide blocks, far house tiles and street cells that nearer things cover (render/occlusion.js); ?occlusion=0 turns it off
  const occlusion = new OcclusionCuller(renderer, scene, camera, () => pipeline.depthTarget());
  if (new URLSearchParams(location.search).get('occlusion') === '0') occlusion.enabled = false;
  const pipeline = new RenderPipeline(renderer, scene, camera, shadows, { mobile: MOBILE, reflection });
  let quality = MOBILE ? 'fast' : 'good';
  try { quality = localStorage.getItem('cuulong-quality') || quality; } catch { /* private mode */ }
  const fogSun = new THREE.Color(0.86, 0.80, 0.70), viewDir = new THREE.Vector3();

  // ---------------------------------------------------------------- UI + loading
  let meta;
  const layers = {};
  const ui = new UI({
    credits: [],
    onView: (id) => { track(`view-${id}`); flyTo(views[id]); },
    onSite: (s) => { track(`site-${s.id}`); openSite(s, true); },
    onLayer: (name, on) => { track(`layer-${name}-${on ? 'on' : 'off'}`); if (name === 'paddies') shared.uRice.value = on ? 1 : 0; if (layers[name]) for (const o of [].concat(layers[name])) o.visible = on; },
    onLang: (lang) => { track(`lang-${lang}`); overlays.setLanguage(lang); },
    onMode: (m) => { track(`mode-${m}`); applyMode(); },
    onQuality: (q) => { track(`quality-${q}`); quality = q; try { localStorage.setItem('cuulong-quality', q); } catch { /* ignore */ } pipeline.setMode(q); },
  });
  ui.loading('meta', 0.02);
  meta = await getJSON('meta.json');
  // Heights at true scale (the data was prepared with x3, which made Bảy Núi look alpine); ?exag=3 for the old look
  const exagParam = parseFloat(new URLSearchParams(location.search).get('exag'));
  meta.vert_exag = exagParam > 0 && exagParam <= 5 ? exagParam : 1;
  ui.credits = meta.credits;

  ui.loading('terrain', 0.08);
  const hbuf = await fetch(DATA + 'heights.bin').then((r) => r.arrayBuffer());
  const h16 = new Uint16Array(hbuf), heights = new Float32Array(h16.length);
  for (let i = 0; i < h16.length; i++) heights[i] = h16[i] / 10;

  ui.loading('tex', 0.25);
  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const [ngx, ngy] = meta.groups;
  const textures = { sat: [], water: [], crop: [] };
  const texKinds = meta.surface ? ['sat', 'water', 'crop'] : ['sat', 'water'];
  let done = 0;
  const texJobs = [];
  for (let gy = 0; gy < ngy; gy++) {
    textures.sat[gy] = []; textures.water[gy] = []; textures.crop[gy] = [];
    for (let gx = 0; gx < ngx; gx++) {
      for (const kind of texKinds) {
        texJobs.push(loader.loadAsync(`${DATA}${kind === 'crop' ? 'surface' : 'tex'}/${kind}_${gx}_${gy}.${kind === 'sat' ? 'jpg' : 'png'}`).then((t) => {
          t.colorSpace = kind === 'sat' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.anisotropy = maxAniso;
          t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
          textures[kind][gy][gx] = t;
          ui.loading('tex', 0.25 + 0.3 * (++done / (ngx * ngy * texKinds.length)));
        }));
      }
    }
  }
  await Promise.all(texJobs);

  const shared = { uTime: { value: 0 }, uExag: { value: meta.vert_exag }, uDetail: { value: 0.45 }, uRice: { value: 1 } };
  // optional live high-res imagery near the camera (needs an Esri key in web/config.js)
  let cfg = {};
  let cfgFile = new URLSearchParams(location.search).get('config') || 'config';   // ?config=config.test for checks
  if (!/^[\w.-]+$/.test(cfgFile)) cfgFile = 'config';   // only sibling files of index.html, never other paths/hosts
  try { cfg = (await import(`../${cfgFile}.js`)).default || {}; } catch { /* no config: Sentinel-2 only */ }
  const imgCredit = document.getElementById('imgCredit');
  if (cfg.credit) imgCredit.textContent = cfg.credit;   // other tile providers need their own credit line
  const imagery = cfg.esriKey || cfg.tileUrl ? new StreamedImagery(meta, {
    key: cfg.esriKey, template: cfg.tileUrl, maxTiles: MOBILE ? 3 : 8, anisotropy: maxAniso,
    onCredit: (on) => imgCredit.classList.toggle('hidden', !on),
    onError: () => console.warn('High-res imagery unavailable (key, quota or network); using Sentinel-2 only.'),
  }) : null;
  if (imagery) ui.credits = [...meta.credits, `Close-up imagery (streamed live): ${cfg.credit || 'Esri World Imagery — Esri, Maxar, Earthstar Geographics'}`];
  // anonymous visit statistics on the public site only (see analytics.js)
  if (initAnalytics(cfg.goatcounter)) ui.credits = [...ui.credits, 'Anonymous visit statistics: GoatCounter (no cookies, no personal data)'];
  const surface = meta.surface ? await SurfaceMap.load(meta, DATA) : null;
  const wetland = await WetlandMap.load(DATA, meta.vert_exag);
  if (wetland) ui.credits = [...ui.credits, wetland.data.credit];
  const terrain = new Terrain(meta, heights, textures, shared,
                              { dataUrl: DATA, maxDetail: QUALITY.maxDetail, anisotropy: maxAniso, imagery, surface });
  terrain.wetland = wetland;
  await terrain.loadRelief();                  // 30 m hills: before anything places houses, trees or roads
  terrain.lodBias = QUALITY.lodBias;
  scene.add(terrain.group);

  ui.loading('data', 0.6);
  const [sites, labels, villageLabels, boundaries, landmarks] = await Promise.all(
    ['sites.json', 'labels.json', 'labels_villages.json', 'boundaries.json', 'landmarks.json'].map(getJSON));
  const overlays = new Overlays(meta);
  overlays.addBoundaries(boundaries);
  overlays.addSites(sites, (s) => openSite(s, false));
  overlays.addLabels(labels, 'labels');
  overlays.addLabels(villageLabels, 'villages');
  for (const g of Object.values(overlays.layers)) scene.add(g);

  const heroData = await getJSON('props.json').catch(() => ({ heroes: [] }));
  const lm = buildLandmarks(landmarks, meta, heroData.heroes, heroData.suppressedLandmarks);
  scene.add(lm);

  // ---------------------------------------------------------------- trees, real buildings, roads (per group)
  const trees = new TreeLayer(meta, terrain, shared, { dataUrl: DATA, nearR: QUALITY.treeNear, farR: QUALITY.treeDist });
  const buildings = new HouseLayer(meta, QUALITY.buildingDist, QUALITY.houseNear, terrain);
  // Codex's Mekong building kit replaces the generated near houses that fit one of its models (loads in the background)
  const buildingKit = new BuildingKit(buildings.uniforms, MOBILE ? 160 : 230);
  buildingKit.load(surface).then(() => {
    buildings.setBuildingKit(buildingKit);
    let kn = 0;                                // water reflections: the light versions all the way in
    reflection?.hooks.push((on) => { const u = buildingKit.uniforms.uKitNear; if (on) { kn = u.value; u.value = 0; } else u.value = kn; });
  }).catch((e) => console.warn('Building kit unavailable', e));
  const roads = new RoadLayer(meta, QUALITY.roadScale, QUALITY.roadRibbon);
  const streets = new StreetFurniture(trees, { traffic: !MOBILE });   // poles, cables, lamps, trees, stalls, traffic
  const roads3d = new Road3DLayer(meta, terrain, { farR: QUALITY.roadRibbon, streets, buildings });
  roads.group.add(roads3d.group);          // the Roads layer switch covers both
  const paddies = new PaddyLayer(terrain, { nearR: MOBILE ? 600 : 1150, trees });   // bunds, dykes, thốt nốt palms
  const trasu = wetland ? new TraSuLayer(wetland, terrain, shared, { mobile: MOBILE }) : null;
  scene.add(trees.group, buildings.group, roads.group, paddies.group, streets.group);
  if (trasu) scene.add(trasu.group);
  // hero houses (the owner's Blender models, ~36k triangles each) replace generated houses only right around the camera
  const props = new PropsLayer(meta, terrain, buildings, shared, MOBILE ? { heroR: 150, heroCap: 6, boatR: 1500, boatCap: 80 }
                                                                        : { heroR: 220, heroCap: 12 });
  scene.add(props.group, props.boatGroup);
  const layerOf = { bld: buildings, roads, ways: roads3d, water: props };
  const keys = Object.keys(meta.instance_counts);
  let loaded = 0;
  await Promise.all(keys.map((key) => {
    const [kind, gx, gy] = key.split('_');
    return layerOf[kind].loadCell(+gx, +gy, `${DATA}inst/${key}.bin`).then(() =>
      ui.loading('houses', 0.65 + 0.33 * (++loaded / keys.length)));
  }));

  props.setLandmarks(heroData.heroes);
  const yards = new YardLayer(meta, terrain, { dataUrl: DATA, mobile: MOBILE });
  buildings.group.add(yards.group);           // follows the Buildings layer switch
  yards.load().catch(e => console.warn('Yards unavailable:', e.message));
  Object.assign(layers, { sites: overlays.layers.sites, route: overlays.layers.route, rings: overlays.layers.rings,
                          labels: overlays.layers.labels, villages: overlays.layers.villages, roads: [roads.group, streets.group],
                          buildings: [buildings.group, props.group], boats: props.boatGroup, trees: trees.group, landmarks: lm,
                          boundaries: overlays.layers.boundaries, paddies: paddies.group });

  // ---------------------------------------------------------------- camera views
  const ex = meta.vert_exag;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const site = Object.fromEntries(sites.sites.map((s) => [s.id, s]));
  const lbl = Object.fromEntries(labels.map((l) => [l.text, l]));
  const story = sites.sites.filter((s) => ['real', 'embellished', 'fictional'].includes(s.match));
  const mx = story.reduce((a, s) => a + s.x, 0) / story.length, my = story.reduce((a, s) => a + s.y, 0) / story.length;
  const near = (x, y, z, dx, dh, dy) => ({ target: V(x, z * ex, -y), pos: V(x + dx, z * ex + dh, -(y + dy)) });
  const views = {
    overview: { target: V(0, 0, 2000), pos: V(14000, 78000, 92000) },
    baynui: { target: V(-26500, 300, -3500), pos: V(-6000, 14000, 30000) },
    sites: { target: V(mx - 1500, 0, -(my + 1500)), pos: V(mx + 13000, 15000, -(my - 24000)) },
    tapa: near(site.B.x, site.B.y, site.B.z, 2200, 1100, -2600),
    nuiket: { pos: V(site.C.x - 250, site.C.z * ex + 60, -(site.C.y + 250)), target: V(site.F.x, 25 * ex, -site.F.y) },
    paddies: { target: V(-26000, 9, 4400), pos: V(-25300, 360, 5050) },
    river: { target: V(-3417, 0, -14963), pos: V(-217, 1100, -11163) },
    chaudoc: near(lbl['Châu Đốc'].x, lbl['Châu Đốc'].y, lbl['Châu Đốc'].z, 1500, 650, -1700),
    longxuyen: near(lbl['Long Xuyên'].x, lbl['Long Xuyên'].y, lbl['Long Xuyên'].z, 1700, 750, -1900),
  };
  // hand-placed trees (Codex: Long Xuyên medians, canal banks and courtyards)
  const placedTrees = new THREE.Group();
  scene.add(placedTrees);
  layers.trees = [].concat(layers.trees, placedTrees);
  getJSON('long-xuyen-greenery.json').then((d) => placedTrees.add(trees.placed(d.trees || []))).catch(() => {});
  if (trasu) {
    Object.assign(views, trasu.views);
    layers.trasu = trasu.group;
    layers.trees = [trees.group, trasu.treeGroup, placedTrees];
    layers.boats = [props.boatGroup, trasu.boatGroup];
    layers.landmarks = [lm, trasu.boardwalk];
  }
  ui.build({ views, sites: sites.sites, layers: Object.keys(layers) });
  // study mode hides the novel's layers; novel mode restores them to their switches
  function applyMode() {
    for (const l of NOVEL_LAYERS) if (layers[l]) for (const o of [].concat(layers[l])) o.visible = ui.mode === 'novel' && ui.layerState[l];
  }
  applyMode();

  let flight = null;
  // tall (portrait) screens need to stand further back to fit the same area
  const fit = (v) => {
    const k = Math.max(1, 1.25 / camera.aspect) ** 0.8;
    return { target: v.target, pos: v.target.clone().add(v.pos.clone().sub(v.target).multiplyScalar(k)) };
  };
  function flyTo(v, ms = 1800) {
    v = fit(v);
    flight = { t0: performance.now(), ms, p0: camera.position.clone(), t0v: controls.target.clone(), p1: v.pos.clone(), t1: v.target.clone() };
  }
  function openSite(s, fly) {
    ui.showSite(s);
    history.replaceState(null, '', '#site=' + encodeURIComponent(s.id));
    if (fly) flyTo(s.id === 'D' && trasu ? views.trasu : near(s.x, s.y, s.z, 1600, 1400, -2400));
  }

  // ---------------------------------------------------------------- picking (landmarks, site dots)
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; flight = null; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(lm.visible ? lm.children : [], false)[0];
    if (hit && hit.instanceId !== undefined) ui.showLandmark(hit.object.userData.items[hit.instanceId]);
  });

  // size from the container (the window can report 0x0 while a tab/pane is hidden; no resize event follows)
  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    // desktop: centre the picture in the space right of the sidebar (316 px)
    if (w > 760) camera.setViewOffset(w, h, -158, 0, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    pipeline.setSize(w, h);
    labelRenderer.setSize(w, h);
    overlays.setResolution(w, h);
    roads.setResolution(w, h);
  };
  new ResizeObserver(resize).observe(container);
  resize();

  // ---------------------------------------------------------------- start
  const startSite = decodeURIComponent((location.hash.match(/site=([^&]+)/) || [])[1] || '');
  const start = fit(views.overview);
  camera.position.copy(start.pos);
  controls.target.copy(start.target);
  if (site[startSite]) { ui.setMode('novel'); openSite(site[startSite], true); }   // shared story links open in novel mode
  await pipeline.setMode(quality);
  ui.quality = quality;
  ui.render();
  ui.loading('ready', 1);
  if (!MOBILE) loadGround().catch((e) => console.warn('Ground photos unavailable:', e.message));
  // left out of the water reflection: the sky (the shader reflects it), flat lines/labels, detailed hero models
  const reflSkip = [sky, ...['roads', 'boundaries', 'route', 'rings', 'sites', 'landmarks', 'props']
    .map((n) => scene.getObjectByName(n)).filter(Boolean)];
  window.__cl = { scene, renderer, camera, controls, terrain, trees, buildings, buildingKit, occlusion, roads, roads3d, props, paddies, yards, surface, trasu, views, shared, pipeline, shadows, sun, reflection };  // debugging handle

  // Optional local QA counter; absent from the normal map UI.
  const stats = new URLSearchParams(location.search).get('stats') === '1' ? document.createElement('output') : null;
  let statStart = performance.now(), statFrames = 0, sceneTriangles = 0;
  // Read the main scene's count before fullscreen post passes reset renderer.info.
  if (stats) scene.onAfterRender = (r, _scene, view) => {
    if (view === camera) sceneTriangles = Math.max(sceneTriangles, r.info.render.triangles);
  };
  if (stats) {
    stats.id = 'perfStats';
    Object.assign(stats.style, { position: 'absolute', right: '12px', bottom: '38px', padding: '8px', color: '#fff',
                                background: '#182820dd', font: '12px monospace', pointerEvents: 'none' });
    container.append(stats);
  }

  const forestHaze = new THREE.Color(.36, .44, .30);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  renderer.setAnimationLoop((now) => {
    if (stats) sceneTriangles = 0;
    shared.uTime.value = now / 1000;
    if (flight) {
      const k = Math.min((now - flight.t0) / flight.ms, 1), e = ease(k);
      camera.position.lerpVectors(flight.p0, flight.p1, e);
      controls.target.lerpVectors(flight.t0v, flight.t1, e);
      if (k >= 1) flight = null;
    }
    controls.update();
    // a hidden pane (0 x 0 view) can leave the camera at NaN: put it back on the overview
    if (!Number.isFinite(camera.position.x + camera.position.y + camera.position.z)) {
      const o = fit(views.overview);
      camera.position.copy(o.pos);
      controls.target.copy(o.target);
    }
    sky.position.copy(camera.position);
    sky.material.uniforms.uCam.value.copy(camera.position);
    GLOBALS.uViewPos.value.copy(camera.position);
    GLOBALS.uCloudTime.value = now / 1000;
    const underCanopy = wetland && camera.position.y < wetland.level + 80 && wetland.floodAt(camera.position.x, -camera.position.z) > .8;
    pipeline.limitPixelRatio(underCanopy ? 1 : null);
    // haze: warmer looking towards the sun, cooler away from it
    camera.getWorldDirection(viewDir);
    const toSun = Math.max(0, viewDir.x * sunDir.x + viewDir.z * sunDir.z) / Math.hypot(sunDir.x, sunDir.z);
    scene.fog.color.copy(underCanopy ? forestHaze : HORIZON).lerp(fogSun, underCanopy ? 0 : toSun * toSun * 0.6);
    scene.fog.density = underCanopy ? 0.0035 : HAZE;
    // stay above the ground
    const inWetland = wetland && wetland.floodAt(camera.position.x, -camera.position.z) > .8;
    const g = terrain.heightAt(camera.position.x, -camera.position.z) * ex + (inWetland ? 2.4 : 8);   // street-level views allowed
    controls.minDistance = inWetland ? 18 : 25;
    const nearPlane = inWetland ? .35 : 5;
    if (camera.near !== nearPlane) { camera.near = nearPlane; camera.updateProjectionMatrix(); }
    if (camera.position.y < g) camera.position.y = g;
    terrain.lodBias = underCanopy ? Math.max(1, QUALITY.lodBias) : QUALITY.lodBias;
    terrain.update(camera);
    paddies.update(camera);
    if (trasu) trasu.update(camera);
    trees.update(camera);
    buildings.update(camera);
    roads.update(camera);
    roads3d.update(camera);
    props.update(camera);
    yards.update(camera);
    overlays.update(camera, underCanopy);
    shadows.update(camera, controls.target, scene);
    // Trà Sư: the flooded forest's water mirrors the trunks and boats, also under the canopy
    const overWetland = wetland && wetland.floodAt(controls.target.x, -controls.target.z) > .5 && camera.position.y < wetland.level + 400;
    if (overWetland) reflection.update(camera, wetland.level + .025, reflSkip);
    else if (!underCanopy && surface) reflection.update(camera, surface.waterHeight(controls.target.x, -controls.target.z), reflSkip);
    else GLOBALS.uRefl.value.x = 0;
    occlusion.apply();
    pipeline.render();
    occlusion.query();
    labelRenderer.render(scene, camera);
    if (stats && ++statFrames && now - statStart >= 2000) {
      const fps = statFrames * 1000 / (now - statStart);
      stats.textContent = `${fps.toFixed(1)} fps · ${sceneTriangles.toLocaleString()} triangles · ${renderer.info.memory.textures} textures · ${(photoInventory.mipBytes / 1048576).toFixed(1)} MiB photo · ${buildings.rejectedWater} water conflicts hidden`;
      stats.dataset.fps = fps.toFixed(1);
      stats.dataset.triangles = sceneTriangles;
      stats.dataset.textures = renderer.info.memory.textures;
      stats.dataset.photoMiB = (photoInventory.mipBytes / 1048576).toFixed(1);
      stats.dataset.photoImages = photoInventory.images;
      stats.dataset.quality = pipeline.mode;
      stats.dataset.view = camera.position.toArray().map(n => n.toFixed(2)).join(',');
      stats.dataset.detailInstances = trasu?.nearMeshes?.reduce((n,m) => n + m.count,0) || 0;
      stats.dataset.rejected = buildings.rejectedWater;
      stats.dataset.paddyTiles = paddies.tiles.size;
      stats.dataset.trasuTrees = trasu?.records?.length || 0;
      stats.dataset.pixelRatio = renderer.getPixelRatio();
      statStart = now; statFrames = 0;
    }
  });
}

main().catch((err) => {
  console.error(err);
  document.getElementById('loadingText').textContent = 'Không tải được bản đồ / Failed to load: ' + err.message;
});
