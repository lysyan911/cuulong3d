// Boundaries, the narrator's route, uncertainty rings, story-site markers and map labels.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export const MATCH_COLORS = {
  real: '#10907f', embellished: '#d0453f', fictional: '#9a4fc4', reference: '#6b7f88', road_note: '#f5b53d',
};
const STORY = new Set(['real', 'embellished', 'fictional']);
const SKIP_REFERENCES = new Set(['Tri Tôn', 'Tịnh Biên']);   // already town labels
const STAGGER = { B: 1, B1: 2, E: 1, F: 2 };                    // stack labels of sites < 1 km apart
// label kinds -> max camera distance (m) at which they are shown
const LABEL_RANGE = { city: 170000, town: 70000, peak: 45000, river: 90000, region: 220000, village: 9000 };

export class Overlays {
  constructor(meta) {
    this.ex = meta.vert_exag;
    this.lineMaterials = [];
    this.layers = {};
    for (const name of ['boundaries', 'route', 'rings', 'sites', 'labels', 'villages']) {
      const g = new THREE.Group();
      g.name = name;
      this.layers[name] = g;
    }
    this.labelItems = [];
    this.siteItems = [];
    this.lang = 'vi';
  }

  w(x, y, z, lift = 0) { return new THREE.Vector3(x, z * this.ex + lift, -y); }

  line(points, color, width, opacity = 1) {
    const g = new LineGeometry();
    g.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
    const m = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, depthTest: true });
    m.resolution.set(window.innerWidth, window.innerHeight);
    this.lineMaterials.push(m);
    const l = new Line2(g, m);
    l.computeLineDistances();
    return l;
  }

  setResolution(w, h) { for (const m of this.lineMaterials) m.resolution.set(w, h); }

  addBoundaries(b) {
    for (const ring of b.districts) {
      this.layers.boundaries.add(this.line(ring.map(([x, y, z]) => this.w(x, y, z, 12)), 0xb593c7, 1.2, 0.75));
    }
    for (const ring of b.province) {
      this.layers.boundaries.add(this.line(ring.map(([x, y, z]) => this.w(x, y, z, 15)), 0x8e3fb0, 3.2));
    }
  }

  addSites(data, onClick) {
    this.layers.route.add(this.line(data.route.map(([x, y, z]) => this.w(x, y, z, 20)), 0xe0632a, 3, 0.95));
    for (const s of data.sites) {
      if (s.ring) this.layers.rings.add(this.line(s.ring.map(([x, y, z]) => this.w(x, y, z, 10)), 0x9a4fc4, 2, 0.9));
      if (s.match === 'reference' && SKIP_REFERENCES.has(s.id)) continue;
      const story = STORY.has(s.match);
      const ground = this.w(s.x, s.y, s.z, 0);
      const lift = (story ? 420 : 260) + (STAGGER[s.id] || 0) * 380;
      const anchor = ground.clone().setY(ground.y + lift);
      this.layers.sites.add(this.line([ground, anchor], story ? 0x2b2b2b : 0x5a5a5a, 1.6, 0.85));
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8),
                                 new THREE.MeshBasicMaterial({ color: MATCH_COLORS[s.match] }));
      dot.position.copy(ground).setY(ground.y + 6);
      dot.scale.setScalar(story ? 45 : 30);
      this.layers.sites.add(dot);

      const el = document.createElement('div');
      el.className = 'site-lbl' + (story ? '' : ' small');
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => { e.stopPropagation(); onClick(s); });
      const lbl = new CSS2DObject(el);
      lbl.position.copy(anchor);
      this.layers.sites.add(lbl);
      this.siteItems.push({ site: s, el, story });
    }
    this.renderSiteLabels();
  }

  siteText(s) {
    if (this.lang === 'vi') return s.short || s.name_vi || s.name;
    return (s.name || '').split(' (')[0];
  }

  renderSiteLabels() {
    for (const { site: s, el, story } of this.siteItems) {
      const color = MATCH_COLORS[s.match];
      const idTxt = story ? s.id : (s.match === 'road_note' ? '!' : '•');
      el.innerHTML = `<span class="site-id" style="background:${color}">${idTxt}</span>` +
        `<span>${escapeHtml(story ? this.siteText(s) : (this.lang === 'vi' ? s.name_vi || s.name : s.name))}</span>` +
        (s.mismatch && story ? '<i class="warn" title="!">!</i>' : '');
    }
  }

  addLabels(list, layer) {
    for (const L of list) {
      const el = document.createElement('div');
      el.className = `lbl ${L.kind}`;
      el.textContent = L.text;
      const o = new CSS2DObject(el);
      const lift = L.kind === 'peak' ? 140 : L.kind === 'village' ? 60 : 220;
      o.position.copy(this.w(L.x, L.y, L.z, lift));
      this.layers[layer].add(o);
      this.labelItems.push({ o, range: LABEL_RANGE[L.kind] || 60000 });
    }
  }

  setLanguage(lang) { this.lang = lang; this.renderSiteLabels(); }

  update(camera, underCanopy = false) {
    for (const name of ['sites', 'route', 'rings']) for (const item of this.layers[name].children) item.visible = !underCanopy;
    for (const it of this.labelItems) it.o.visible = !underCanopy && camera.position.distanceTo(it.o.position) < it.range;
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
