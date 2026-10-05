import * as THREE from 'three';
import { track } from './analytics.js';
import { fold, encodeView, decodeView, searchPlaces } from './place-links.js';

const TEXT = {
  vi: {
    search: 'Tìm địa điểm', placeholder: 'Long Xuyên, Trà Sư, chùa, tên làng…', results: 'Kết quả', noResults: 'Không tìm thấy địa điểm. Thử tên ngắn hơn.',
    searchHint: 'Tìm có hoặc không có dấu · Enter chọn · ↑/↓ chọn kết quả',
    town: 'Địa danh', village: 'Làng / ấp', landmark: 'Công trình', story: 'Địa điểm truyện', view: 'Góc nhìn',
    help: 'Hướng dẫn', share: 'Chia sẻ góc nhìn', north: 'Hướng Bắc', close: 'Đóng', copied: 'Đã sao chép liên kết góc nhìn', copy: 'Sao chép', copyHint: 'Sao chép liên kết này để mở lại đúng góc nhìn.',
    welcome: 'Khám phá An Giang', welcomeText: 'Kéo để di chuyển, cuộn để phóng to. Bấm ? để xem hướng dẫn.', gotIt: 'Đã hiểu', controls: 'Điều khiển',
    mouse: 'Chuột: kéo trái để di chuyển; kéo phải để xoay; cuộn để phóng to / thu nhỏ.',
    touch: 'Điện thoại: kéo một ngón để di chuyển; hai ngón để xoay; chụm / mở hai ngón để thu / phóng.',
    keys: 'Bàn phím: mũi tên hoặc W A S D di chuyển; + / − phóng; Q / E xoay; Home hướng Bắc; Escape đóng bảng.',
    street: 'Mức đường phố: tìm một địa điểm rồi phóng gần, xoay ngang để nhìn các ngôi nhà. Trà Sư có góc nhìn dưới tán tràm.',
    searchHelp: 'Tìm kiếm gồm thành phố, làng, công trình và góc nhìn. Chế độ Truyện thêm các địa điểm hư cấu.',
    shareHelp: 'Nút liên kết lưu vị trí và hướng camera. Liên kết địa điểm truyện cũ vẫn mở được.',
    focusMap: 'Bản đồ 3D An Giang. Dùng các phím mũi tên để di chuyển.', menu: 'Mở hoặc đóng bảng điều khiển', language: 'Chuyển ngôn ngữ', tools: 'Công cụ bản đồ',
  },
  en: {
    search: 'Find a place', placeholder: 'Long Xuyên, Trà Sư, temples, villages…', results: 'Results', noResults: 'No places found. Try a shorter name.',
    searchHint: 'Accents are optional · Enter selects · ↑/↓ moves through results',
    town: 'Place', village: 'Village', landmark: 'Landmark', story: 'Story place', view: 'View',
    help: 'Help', share: 'Share this view', north: 'Face north', close: 'Close', copied: 'View link copied', copy: 'Copy', copyHint: 'Copy this link to reopen the same camera view.',
    welcome: 'Explore An Giang', welcomeText: 'Drag to move; scroll to zoom. Open ? for all the controls.', gotIt: 'Got it', controls: 'Controls',
    mouse: 'Mouse: left-drag to pan; right-drag to rotate; scroll to zoom.',
    touch: 'Phone: one finger to pan; two fingers to rotate; pinch to zoom.',
    keys: 'Keyboard: arrows or W A S D pan; + / − zoom; Q / E rotate; Home faces north; Escape closes panels.',
    street: 'Street level: find a place, zoom in and rotate to look along the houses. Trà Sư also has a forest-canal view.',
    searchHelp: 'Search covers towns, villages, landmarks and views. Novel mode also includes story places.',
    shareHelp: 'The link button saves the camera position and direction. Older story-place links still work.',
    focusMap: '3D map of An Giang. Use arrow keys to pan.', menu: 'Open or close map controls', language: 'Change language', tools: 'Map tools',
  },
};

export class PlacesUX {
  constructor({ ui, camera, controls, terrain, meta, views, labels, villages, landmarks, heroes, sites, extraPlaces = [], flyTo, cancelFlight }) {
    Object.assign(this, { ui, camera, controls, terrain, meta, views, flyTo, cancelFlight });
    this.$ = id => document.getElementById(id); this.items = []; this.results = []; this.active = -1;
    this.lastCompass = 0; this.openedFrom = null; ui.extras = this;
    const add = p => {
      if (!p.name || !Number.isFinite(p.x + p.n)) return;
      if (this.items.some(q => q.name === p.name && Math.hypot(q.x - p.x, q.n - p.n) < 80)) return;
      p.search = fold([p.name, p.en, p.alias].filter(Boolean).join(' ')); this.items.push(p);
    };
    for (const l of labels) add({ name: l.text, type: 'town', x: l.x, n: l.y, h: l.z, featured: ['city', 'town'].includes(l.kind) });
    for (const l of villages) add({ name: l.text, type: 'village', x: l.x, n: l.y, h: l.z });
    for (const l of landmarks) add({ name: l.name, type: 'landmark', x: l.x, n: l.y, h: l.z });
    for (const l of heroes) add({ name: l.name, type: 'landmark', x: l.x, n: l.y, h: terrain.heightAt(l.x, l.y), featured: true, alias: l.model });
    for (const p of extraPlaces) add({ ...p, type: 'landmark' });
    for (const s of sites) add({ name: s.short || s.name_vi || s.name, en: s.name, type: 'story', x: s.x, n: s.y, h: s.z, story: true, site: s });
    for (const [id, v] of Object.entries(views)) add({ name: ui.viewName(id), en: ui.viewName(id, 'en'), type: 'view', x: v.target.x, n: -v.target.z, view: v, story: id === 'sites', alias: id, featured: ['trasu', 'lxCathedral', 'agu'].includes(id) });
    this.$('placeSearchBtn').onclick = () => this.show('placeSearch');
    this.$('helpBtn').onclick = () => { track('help-open'); this.dismissWelcome(); this.show('mapHelp'); };
    this.$('shareBtn').onclick = () => this.share();
    this.$('compassBtn').onclick = () => this.north();
    this.$('placeQuery').oninput = () => this.search();
    this.$('placeQuery').onkeydown = e => this.searchKey(e);
    for (const b of document.querySelectorAll('[data-dialog-close]')) b.onclick = () => this.hide(b.dataset.dialogClose);
    for (const d of document.querySelectorAll('.ux-dialog')) d.addEventListener('close', () => (this.openedFrom?.getClientRects().length ? this.openedFrom : this.controls.domElement).focus());
    this.$('welcomeClose').onclick = () => this.dismissWelcome();
    this.$('welcomeHelp').onclick = () => { this.$('helpBtn').focus(); this.$('helpBtn').click(); };
    this.$('shareCopy').onclick = () => this.copy(this.$('shareLink').value);
    this.$('shareLink').onclick = e => e.currentTarget.select();
    this.changeCompass = () => this.compass(); controls.addEventListener('change', this.changeCompass);
    this.keyListener = e => this.key(e); document.addEventListener('keydown', this.keyListener);
    let dismissed = false; try { dismissed = localStorage.getItem('cuulong-controls-dismissed-v1') === 'yes'; } catch { /* private browsing */ }
    this.$('mapWelcome').hidden = dismissed || matchMedia('(max-width:760px), (pointer:coarse)').matches;
    if (!dismissed) this.$('helpBtn').classList.add('new-help');
    this.render(); this.restore(); this.compass(true);
    this.hashListener = () => { if (decodeView(location.hash, meta.width_m, meta.height_m)) this.restore(); };
    window.addEventListener('hashchange', this.hashListener);
  }

  t(key) { return TEXT[this.ui.lang][key]; }
  render() {
    for (const e of document.querySelectorAll('[data-ux]')) e.textContent = this.t(e.dataset.ux);
    for (const [id, key] of [['placeSearchBtn', 'search'], ['helpBtn', 'help'], ['shareBtn', 'share'], ['compassBtn', 'north'], ['menuBtn', 'menu'], ['langBtn', 'language'], ['infoClose', 'close']]) {
      const e = this.$(id); e.setAttribute('aria-label', this.t(key)); e.title = this.t(key);
    }
    const q = this.$('placeQuery'); q.placeholder = this.t('placeholder'); q.setAttribute('aria-label', this.t('search'));
    this.$('mapTools').setAttribute('aria-label', this.t('tools'));
    this.$('shareLink').setAttribute('aria-label', this.t('share'));
    this.controls.domElement.setAttribute('aria-label', this.t('focusMap'));
    this.controls.domElement.setAttribute('tabindex', '0'); this.controls.domElement.setAttribute('role', 'region');
    this.search();
  }
  show(id) {
    this.openedFrom = document.activeElement;
    this.$('sidebar').classList.remove('open'); this.$('menuBtn').setAttribute('aria-expanded', 'false');
    const d = this.$(id); if (!d.open) d.showModal();
    if (id === 'placeSearch') { this.search(); this.$('placeQuery').focus(); }
  }
  hide(id) { this.$(id).close(); }
  dismissWelcome() {
    this.$('mapWelcome').hidden = true; this.$('helpBtn').classList.remove('new-help');
    try { localStorage.setItem('cuulong-controls-dismissed-v1', 'yes'); } catch { /* private browsing */ }
  }
  search() {
    this.results = searchPlaces(this.items, this.$('placeQuery').value, this.ui.mode === 'novel'); this.active = -1;
    const list = this.$('placeResults'); list.replaceChildren(); this.$('placeQuery').removeAttribute('aria-activedescendant');
    this.$('placeEmpty').hidden = this.results.length > 0;
    for (let i = 0; i < this.results.length; i++) {
      const p = this.results[i], li = document.createElement('li'), b = document.createElement('button');
      b.id = 'place-result-' + i; b.type = 'button'; b.className = 'place-result'; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', 'false');
      const name = document.createElement('strong'), kind = document.createElement('span');
      name.textContent = this.ui.lang === 'en' ? p.en || p.name : p.name; kind.textContent = this.t(p.type);
      b.append(name, kind); b.onclick = () => this.choose(p); li.append(b); list.append(li);
    }
    this.$('placeResultCount').textContent = this.results.length + ' · ' + this.t('results');
  }
  searchKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!this.results.length) return;
      e.preventDefault(); this.active = this.active < 0 ? (e.key === 'ArrowDown' ? 0 : this.results.length - 1) : (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.results.length) % this.results.length;
      for (let i = 0; i < this.results.length; i++) {
        const b = this.$('place-result-' + i); b.setAttribute('aria-selected', String(i === this.active));
        if (i === this.active) { this.$('placeQuery').setAttribute('aria-activedescendant', b.id); b.scrollIntoView({ block: 'nearest' }); }
      }
    } else if (e.key === 'Enter' && this.results.length) { e.preventDefault(); this.choose(this.results[Math.max(0, this.active)]); }
  }
  choose(p) {
    track('search-' + p.type); this.openedFrom = this.controls.domElement; this.hide('placeSearch'); this.cancelFlight();
    if (p.site) this.ui.cb.onSite(p.site);
    else if (p.view) this.flyTo(p.view);
    else {
      const h = this.terrain.heightAt(p.x, p.n) * this.meta.vert_exag;
      const close = p.type === 'landmark', d = p.distance || (close ? 120 : 750);
      this.flyTo({ target: new THREE.Vector3(p.x, h + (close ? 8 : 2), -p.n), pos: new THREE.Vector3(p.x + d * .7, h + d * .5, -p.n + d) });
    }
    this.controls.domElement.focus({ preventScroll: true });
  }
  compass(force = false) {
    if (!force && performance.now() - this.lastCompass < 100) return;
    this.lastCompass = performance.now();
    const o = this.camera.position.clone().sub(this.controls.target);
    const bearing = Math.atan2(-o.x, o.z) * 180 / Math.PI;
    this.$('compassNeedle').style.transform = `rotate(${-bearing}deg)`;
  }
  north() {
    this.cancelFlight(); const damping = this.controls.enableDamping; this.controls.enableDamping = false;
    this.controls.update();
    const o = this.camera.position.clone().sub(this.controls.target), r = Math.hypot(o.x, o.z);
    if (r > .01) this.camera.position.set(this.controls.target.x, this.camera.position.y, this.controls.target.z + r);
    this.controls.update(); this.controls.enableDamping = damping; this.compass(true); track('help-north');
  }
  key(e) {
    if (e.key === 'Escape') {
      this.$('sidebar').classList.remove('open'); this.$('menuBtn').setAttribute('aria-expanded', 'false');
      if (!document.querySelector('dialog[open]')) this.ui.hideInfo(); return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]') || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(e.target.tagName) || e.target.closest('[role="button"]') || e.target.isContentEditable) return;
    const k = e.key.toLowerCase(); if (!['arrowup','arrowdown','arrowleft','arrowright','w','a','s','d','+','=','-','_','q','e','home'].includes(k)) return;
    e.preventDefault(); this.cancelFlight();
    if (k === 'home') { this.north(); return; }
    const o = this.camera.position.clone().sub(this.controls.target), d = o.length();
    if (['+', '=', '-', '_'].includes(k)) {
      const n = THREE.MathUtils.clamp(d * (k === '+' || k === '=' ? .85 : 1.18), this.controls.minDistance, this.controls.maxDistance);
      this.camera.position.copy(this.controls.target).add(o.multiplyScalar(n / Math.max(d, .001)));
    } else if (k === 'q' || k === 'e') {
      o.applyAxisAngle(new THREE.Vector3(0, 1, 0), (k === 'q' ? 1 : -1) * .12); this.camera.position.copy(this.controls.target).add(o);
    } else {
      const step = THREE.MathUtils.clamp(d * .045, 2, 1800) * (e.shiftKey ? 2 : 1);
      const forward = new THREE.Vector3(-o.x, 0, -o.z).normalize(), right = new THREE.Vector3(-forward.z, 0, forward.x);
      const delta = (['w','arrowup','s','arrowdown'].includes(k) ? forward : right).multiplyScalar(step * (['s','arrowdown','a','arrowleft'].includes(k) ? -1 : 1));
      const x = this.controls.target.x + delta.x, z = this.controls.target.z + delta.z;
      if (Math.abs(x) > this.meta.width_m / 2 || Math.abs(z) > this.meta.height_m / 2) return;
      this.camera.position.add(delta); this.controls.target.add(delta);
    }
    this.controls.update(); this.compass(true);
  }
  async share() {
    const hash = encodeView(this.camera.position, this.controls.target, this.ui.mode), url = new URL(location.href);
    url.search = ''; if (this.meta.vert_exag !== 1) url.searchParams.set('exag', this.meta.vert_exag);
    url.hash = hash; history.replaceState(null, '', location.pathname + location.search + hash);
    track('share-view'); this.$('shareLink').value = url.href;
    if (!await this.copy(url.href)) this.show('mapShare');
  }
  async copy(text) {
    try { await navigator.clipboard.writeText(text); this.toast(this.t('copied')); return true; }
    catch { return false; }
  }
  toast(text) {
    this.$('mapStatus').textContent = text; clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.$('mapStatus').textContent = ''; }, 3500);
  }
  restore() {
    const v = decodeView(location.hash, this.meta.width_m, this.meta.height_m); if (!v) return false;
    this.cancelFlight(); this.ui.setMode(v.mode);
    const damping = this.controls.enableDamping; this.controls.enableDamping = false;
    this.controls.update();       // drain any old pan/rotation before applying the shared pose
    this.camera.position.fromArray(v.position); this.controls.target.fromArray(v.target);
    // The render loop uses this same wetland floor. Apply it before OrbitControls
    // clamps a shared canal view during initial startup.
    const p = this.camera.position;
    this.controls.minDistance = this.terrain.wetland?.floodAt(p.x, -p.z) > .8 ? 18 : 25;
    this.controls.update(); this.controls.enableDamping = damping; this.compass(true); return true;
  }
  dispose() { this.controls.removeEventListener('change', this.changeCompass); document.removeEventListener('keydown', this.keyListener); window.removeEventListener('hashchange', this.hashListener); clearTimeout(this.toastTimer); }
}
