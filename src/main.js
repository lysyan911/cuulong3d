// Cửu Long 3D Map — three.js viewer. Data comes from scripts/export_web.py (web/data/).
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { Terrain } from './terrain.js';
import { StreamedImagery } from './imagery.js';
import { TreeLayer, RoadLayer, buildLandmarks } from './world.js';
import { HouseLayer } from './houses.js';
import { Overlays } from './overlays.js';
import { UI } from './ui.js';

const DATA = 'data/';
const MOBILE = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
const QUALITY = MOBILE
  ? { pixelRatio: 1, treeDist: 11000, buildingDist: 7000, houseNear: 900, roadScale: 0.6, lodBias: 1, maxDetail: 4 }
  : { pixelRatio: Math.min(devicePixelRatio, 1.5), treeDist: 22000, buildingDist: 14000, houseNear: 1800, roadScale: 1, lodBias: 0,
      maxDetail: 10 };

const getJSON = (f) => fetch(DATA + f).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });

async function main() {
  // ---------------------------------------------------------------- renderer, scene, camera
  const container = document.getElementById('viewport');
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(QUALITY.pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.append(renderer.domElement);
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(innerWidth, innerHeight);
  Object.assign(labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
  container.append(labelRenderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 5, 700000);
  const controls = new MapControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, screenSpacePanning: false, maxPolarAngle: 1.47,
                            minDistance: 120, maxDistance: 320000, zoomToCursor: true });

  // ---------------------------------------------------------------- sky, sun, haze
  // Gradient sky dome with soft clouds (follows the camera); the same dome lights the scene via PMREM.
  const HORIZON = new THREE.Color(0.74, 0.80, 0.86), ZENITH = new THREE.Color(0.22, 0.42, 0.78);
  const skyMaterial = () => new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: { uHorizon: { value: HORIZON }, uZenith: { value: ZENITH }, uSun: { value: sunDir } },
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vDir; uniform vec3 uHorizon, uZenith, uSun;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      void main() {
        float e = vDir.y;
        vec3 col = mix(uHorizon, uZenith, pow(clamp(e, 0.0, 1.0), 0.55));
        col = mix(col, uHorizon * 0.85, smoothstep(0.0, -0.2, e));            // below horizon: haze
        vec2 p = vDir.xz / max(e + 0.12, 0.05) * 1.6;                          // clouds on a flat ceiling
        float c = n(p) * 0.6 + n(p * 2.3) * 0.3 + n(p * 5.1) * 0.1;
        c = smoothstep(0.55, 0.78, c) * smoothstep(0.02, 0.2, e);
        col = mix(col, vec3(0.97), c * 0.85);
        col += vec3(1.0, 0.9, 0.7) * pow(max(dot(vDir, uSun), 0.0), 400.0) * 2.0;  // sun disc
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(52), THREE.MathUtils.degToRad(225));
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400000, 48, 24), skyMaterial());
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), skyMaterial()));
  scene.environment = pmrem.fromScene(envScene, 0, 1, 2000).texture;
  scene.environmentIntensity = 0.75;
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.copy(sunDir).multiplyScalar(100000);
  scene.add(sun, new THREE.HemisphereLight(0xcfe3ff, 0x5b6a3a, 0.9));
  scene.fog = new THREE.Fog(HORIZON.clone(), 35000, 330000);

  // ---------------------------------------------------------------- UI + loading
  let meta;
  const layers = {};
  const ui = new UI({
    credits: [],
    onView: (id) => flyTo(views[id]),
    onSite: (s) => openSite(s, true),
    onLayer: (name, on) => { if (layers[name]) for (const o of [].concat(layers[name])) o.visible = on; },
    onLang: (lang) => overlays.setLanguage(lang),
  });
  ui.loading('meta', 0.02);
  meta = await getJSON('meta.json');
  ui.credits = meta.credits;

  ui.loading('terrain', 0.08);
  const hbuf = await fetch(DATA + 'heights.bin').then((r) => r.arrayBuffer());
  const h16 = new Uint16Array(hbuf), heights = new Float32Array(h16.length);
  for (let i = 0; i < h16.length; i++) heights[i] = h16[i] / 10;

  ui.loading('tex', 0.25);
  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const [ngx, ngy] = meta.groups;
  const textures = { sat: [], water: [] };
  let done = 0;
  const texJobs = [];
  for (let gy = 0; gy < ngy; gy++) {
    textures.sat[gy] = []; textures.water[gy] = [];
    for (let gx = 0; gx < ngx; gx++) {
      for (const kind of ['sat', 'water']) {
        texJobs.push(loader.loadAsync(`${DATA}tex/${kind}_${gx}_${gy}.${kind === 'sat' ? 'jpg' : 'png'}`).then((t) => {
          t.colorSpace = kind === 'sat' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.anisotropy = maxAniso;
          t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
          textures[kind][gy][gx] = t;
          ui.loading('tex', 0.25 + 0.3 * (++done / (ngx * ngy * 2)));
        }));
      }
    }
  }
  await Promise.all(texJobs);

  const shared = { uTime: { value: 0 }, uExag: { value: meta.vert_exag }, uDetail: { value: 0.45 } };
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
  const terrain = new Terrain(meta, heights, textures, shared,
                              { dataUrl: DATA, maxDetail: QUALITY.maxDetail, anisotropy: maxAniso, imagery });
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

  const lm = buildLandmarks(landmarks, meta);
  scene.add(lm);

  // ---------------------------------------------------------------- trees, real buildings, roads (per group)
  const trees = new TreeLayer(meta, QUALITY.treeDist);
  const buildings = new HouseLayer(meta, QUALITY.buildingDist, QUALITY.houseNear);
  const roads = new RoadLayer(meta, QUALITY.roadScale);
  scene.add(trees.group, buildings.group, roads.group);
  const layerOf = { trees, bld: buildings, roads };
  const keys = Object.keys(meta.instance_counts);
  let loaded = 0;
  await Promise.all(keys.map((key) => {
    const [kind, gx, gy] = key.split('_');
    return layerOf[kind].loadCell(+gx, +gy, `${DATA}inst/${key}.bin`).then(() =>
      ui.loading(kind === 'trees' ? 'trees' : 'houses', 0.65 + 0.33 * (++loaded / keys.length)));
  }));

  Object.assign(layers, { sites: overlays.layers.sites, route: overlays.layers.route, rings: overlays.layers.rings,
                          labels: overlays.layers.labels, villages: overlays.layers.villages, roads: roads.group,
                          buildings: buildings.group, trees: trees.group, landmarks: lm,
                          boundaries: overlays.layers.boundaries });

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
    river: { target: V(-3417, 0, -14963), pos: V(-217, 1100, -11163) },
    chaudoc: near(lbl['Châu Đốc'].x, lbl['Châu Đốc'].y, lbl['Châu Đốc'].z, 1500, 650, -1700),
    longxuyen: near(lbl['Long Xuyên'].x, lbl['Long Xuyên'].y, lbl['Long Xuyên'].z, 1700, 750, -1900),
  };
  ui.build({ views, sites: sites.sites, layers: Object.keys(layers) });

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
    if (fly) flyTo(near(s.x, s.y, s.z, 1600, 1400, -2400));
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
  if (site[startSite]) openSite(site[startSite], true);
  ui.loading('ready', 1);
  window.__cl = { scene, renderer, camera, controls, terrain, trees, buildings, roads, views, shared };  // debugging handle

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  renderer.setAnimationLoop((now) => {
    shared.uTime.value = now / 1000;
    if (flight) {
      const k = Math.min((now - flight.t0) / flight.ms, 1), e = ease(k);
      camera.position.lerpVectors(flight.p0, flight.p1, e);
      controls.target.lerpVectors(flight.t0v, flight.t1, e);
      if (k >= 1) flight = null;
    }
    controls.update();
    sky.position.copy(camera.position);
    scene.fog.near = 30000 + camera.position.y * 1.3;   // haze scales with altitude: clear overviews,
    scene.fog.far = 330000 + camera.position.y * 2.5;   // hazy horizons when low
    // stay above the ground
    const g = terrain.heightAt(camera.position.x, -camera.position.z) * ex + 40;
    if (camera.position.y < g) camera.position.y = g;
    terrain.update(camera);
    trees.update(camera);
    buildings.update(camera);
    roads.update(camera);
    overlays.update(camera);
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  });
}

main().catch((err) => {
  console.error(err);
  document.getElementById('loadingText').textContent = 'Không tải được bản đồ / Failed to load: ' + err.message;
});
