// Sidebar, info panel, language toggle, credits, loading screen.
import { MATCH_COLORS, escapeHtml } from './overlays.js';

// Study mode (default) hides everything from the novel; Novel mode (for fans) shows the story places and notes.
export const NOVEL_LAYERS = ['sites', 'route', 'rings'];
const NOVEL_VIEWS = ['sites'];
const isStoryCredit = (c) => /novel|fan interpretation|Cửu Long Quái/i.test(c);

const T = {
  vi: {
    title: 'Dự án Cửu Long', subtitle: 'Bản đồ 3D Bảy Núi – An Giang (trước 2025)',
    mode: 'Chế độ', modes: { study: 'Học tập', novel: 'Truyện' },
    modeNote: { study: 'Bản đồ địa lý thuần: không có chi tiết từ tiểu thuyết.', novel: 'Dành cho người hâm mộ: hiện các địa điểm trong truyện Cửu Long Quái Sự Ký và ghi chú so với thực tế.' },
    about_study: 'Bản đồ 3D địa lý An Giang (trước 2025): địa hình, sông kênh, rừng, ruộng lúa, làng và đô thị. Dự án cá nhân, phi thương mại.',
    views: 'Góc nhìn', places: 'Địa điểm trong truyện', layers: 'Lớp hiển thị', quality: 'Chất lượng hình ảnh',
    qualityModes: { fast: 'Nhanh', good: 'Đẹp', cinematic: 'Điện ảnh' },
    qualityNote: 'Điện ảnh: bóng nắng sắc nét, che khuất ánh sáng đầy đủ — dành cho cận cảnh, máy mạnh.',
    weather: 'Thời tiết', weatherModes: { clear: 'Quang', cloudy: 'Ít mây', overcast: 'U ám', rain: 'Mưa rào', mist: 'Sương sớm', auto: 'Tự động' },
    timeOfDay: 'Giờ trong ngày', timeModes: { sunrise: 'Bình minh', morning: 'Buổi sáng', noon: 'Trưa', afternoon: 'Chiều', sunset: 'Hoàng hôn' },
    weatherNote: 'Tự động: chiều miền Tây, phần lớn nắng ráo, thỉnh thoảng mây kéo đến thành cơn mưa rào rồi tạnh.', credits: 'Nguồn dữ liệu', close: 'Đóng',
    m_real: 'Có thật', m_embellished: 'Có thật + hư cấu', m_fictional: 'Hư cấu', m_reference: 'Tham khảo',
    m_road_note: 'Ghi chú đường', m_conflict: 'Truyện khác thực tế',
    about: 'Dự án của người hâm mộ, phi thương mại. Vị trí đặt theo truyện; chỗ nào truyện khác thực tế đều có ghi chú.',
    hint: 'Kéo để di chuyển · Chuột phải / hai ngón để xoay · Cuộn để phóng to · Bấm vào địa điểm để đọc',
    scale_note: 'Ảnh vệ tinh Sentinel-2 (10 m) chụp mùa khô 2025. Nhà cửa là dấu chân công trình thật (Overture Maps), kiểu nhà và chiều cao ước tính. Cây mọc đúng nơi có tán cây thật (ESA WorldCover 2021), loài cây ước tính theo vùng. Trà Sư có lớp rừng ngập nước dựng theo ảnh tham khảo; kênh, cầu, mực nước và vị trí động vật chỉ minh họa. Độ cao địa hình đúng tỉ lệ thật; nhà và cây ở xa phóng ×2 để dễ nhìn.',
    canon: 'Theo truyện', reality: 'Thực tế', invented: 'Chi tiết hư cấu', fly: 'Bay tới', osm: 'Xem trên OpenStreetMap',
    uncertain: (m) => `Vị trí ước đoán, sai số khoảng ±${m >= 1000 ? (m / 1000).toLocaleString('vi') + ' km' : m + ' m'}`,
    lm_note: 'Công trình có thật (theo OpenStreetMap). Mô hình chỉ mang tính minh họa.',
    lm: { khmer_pagoda: 'Chùa Khmer', viet_pagoda: 'Chùa / miếu', church: 'Nhà thờ', mosque: 'Thánh đường Hồi giáo', caodai: 'Thánh thất Cao Đài' },
    loading: { meta: 'Đang đọc thông tin…', terrain: 'Đang tải địa hình…', tex: 'Đang tải bản đồ màu…', data: 'Đang tải địa điểm…',
               trees: 'Đang trồng cây…', houses: 'Đang dựng nhà…', models: 'Đang tải biển báo, cầu và bờ sông…', ready: 'Sẵn sàng' },
    layer: { sites: 'Địa điểm truyện', route: 'Lộ trình nhân vật', rings: 'Vùng ước đoán', labels: 'Địa danh',
             villages: 'Tên làng, ấp', roads: 'Đường sá', buildings: 'Nhà cửa', boats: 'Ghe thuyền', trees: 'Cây cối', landmarks: 'Chùa, nhà thờ…',
             boundaries: 'Ranh giới', paddies: 'Ruộng lúa', trasu: 'Rừng ngập nước Trà Sư', fauna: 'Động vật' },
    view: { faunaPilot: 'Động vật – ruộng Tri Tôn', overview: 'Toàn tỉnh', baynui: 'Bảy Núi', sites: 'Các địa điểm', tapa: 'Tà Pạ – Tri Tôn', nuiket: 'Từ đỉnh Núi Két', paddies: 'Ruộng lúa – Tri Tôn',
            trasu: 'Trà Sư – toàn cảnh', trasuCanal: 'Trà Sư – dưới tán tràm', trasuBirds: 'Trà Sư – chim nước', river: 'Sông Hậu – Châu Đốc', longxuyen: 'Long Xuyên', chaudoc: 'Châu Đốc',
            lxCathedral: 'Nhà thờ Long Xuyên', agu: 'Đại học An Giang',
            'ba-chua-xu': 'Miếu Bà Chúa Xứ Núi Sam', 'tay-an': 'Chùa Tây An',
            'thoai-ngoc-hau': 'Lăng Thoại Ngọc Hầu', 'nui-sam': 'Núi Sam – toàn cảnh',
            'van-linh': 'Chùa Vạn Linh', 'phat-lon': 'Chùa Phật Lớn',
            'nui-cam-maitreya': 'Phật Di Lặc Núi Cấm', 'nui-cam': 'Núi Cấm – toàn cảnh',
            'nui-cam-lake': 'Hồ Thủy Liêm' },
  },
  en: {
    title: 'Cửu Long Project', subtitle: '3D map of Bảy Núi – An Giang (pre-2025)',
    mode: 'Mode', modes: { study: 'Study', novel: 'Novel' },
    modeNote: { study: 'Pure geography: nothing from the novel.', novel: 'For fans: shows the places of the novel Cửu Long Quái Sự Ký and how they compare with reality.' },
    about_study: '3D geography of An Giang (pre-2025): terrain, rivers and canals, forests, rice fields, villages and towns. Personal, non-commercial project.',
    views: 'Views', places: 'Places in the story', layers: 'Layers', quality: 'Picture quality',
    qualityModes: { fast: 'Fast', good: 'Good', cinematic: 'Cinematic' },
    qualityNote: 'Cinematic: sharp sun shadows and full ambient occlusion, for close-ups on a strong computer.',
    weather: 'Weather', weatherModes: { clear: 'Clear', cloudy: 'Partly cloudy', overcast: 'Overcast', rain: 'Rain shower', mist: 'Morning mist', auto: 'Auto' },
    timeOfDay: 'Time of day', timeModes: { sunrise: 'Sunrise', morning: 'Morning', noon: 'Noon', afternoon: 'Afternoon', sunset: 'Sunset' },
    weatherNote: 'Auto: a delta afternoon, mostly fair; now and then clouds build into a short shower, then it clears.', credits: 'Data sources', close: 'Close',
    m_real: 'Real place', m_embellished: 'Real + invented', m_fictional: 'Invented', m_reference: 'Reference',
    m_road_note: 'Road note', m_conflict: 'Story differs from reality',
    about: 'Non-commercial fan project. Places sit where the novel puts them; conflicts with reality are noted.',
    hint: 'Drag to pan · Right-drag / two fingers to rotate · Scroll to zoom · Click a place to read about it',
    scale_note: 'Sentinel-2 satellite imagery (10 m), dry season 2025. Buildings are real footprints (Overture Maps); house types and heights are estimated. Trees stand where real tree cover is (ESA WorldCover 2021); species are estimated by area. Trà Sư has a reference-based flooded forest; internal channels, boardwalk, water level and wildlife positions are illustrative. Terrain heights at true scale; distant houses and trees ×2 so they read on the map.',
    canon: 'In the novel', reality: 'In reality', invented: 'Invented details', fly: 'Fly here', osm: 'Open in OpenStreetMap',
    uncertain: (m) => `Estimated position, about ±${m >= 1000 ? m / 1000 + ' km' : m + ' m'}`,
    lm_note: 'Real building (from OpenStreetMap). The model is illustrative only.',
    lm: { khmer_pagoda: 'Khmer pagoda', viet_pagoda: 'Pagoda / temple', church: 'Church', mosque: 'Mosque', caodai: 'Cao Đài temple' },
    loading: { meta: 'Reading map info…', terrain: 'Loading terrain…', tex: 'Loading map colours…', data: 'Loading places…',
               trees: 'Planting trees…', houses: 'Building houses…', models: 'Loading signs, bridges and river banks…', ready: 'Ready' },
    layer: { sites: 'Story places', route: "Narrator's route", rings: 'Uncertainty', labels: 'Place names',
             villages: 'Village names', roads: 'Roads & paths', buildings: 'Buildings', trees: 'Trees',
             landmarks: 'Pagodas, churches…', boundaries: 'Boundaries', boats: 'Boats', paddies: 'Rice fields', trasu: 'Trà Sư flooded forest', fauna: 'Wildlife' },
    view: { faunaPilot: 'Wildlife – Tri Tôn fields', overview: 'Whole province', baynui: 'Seven Mountains', sites: 'Story places', tapa: 'Tà Pạ – Tri Tôn',
            nuiket: 'From Núi Két summit', paddies: 'Tri Tôn rice fields', trasu: 'Trà Sư – aerial', trasuCanal: 'Trà Sư – forest canal', trasuBirds: 'Trà Sư – waterbirds', river: 'Hậu River – Châu Đốc', longxuyen: 'Long Xuyên', chaudoc: 'Châu Đốc',
            lxCathedral: 'Long Xuyên Cathedral', agu: 'An Giang University',
            'ba-chua-xu': 'Lady of the Realm Shrine – Sam Mountain', 'tay-an': 'Tay An Pagoda',
            'thoai-ngoc-hau': 'Thoai Ngoc Hau Tomb', 'nui-sam': 'Sam Mountain – panorama',
            'van-linh': 'Van Linh Pagoda', 'phat-lon': 'Big Buddha Pagoda',
            'nui-cam-maitreya': 'Maitreya Buddha – Cam Mountain', 'nui-cam': 'Cam Mountain – panorama',
            'nui-cam-lake': 'Thuy Liem Lake' },
  },
};

export class UI {
  constructor({ credits, onView, onSite, onLayer, onLang, onMode, onQuality, onWeather }) {
    this.lang = 'vi';
    this.cb = { onView, onSite, onLayer, onLang, onMode, onQuality, onWeather };
    this.weather = 'clear';
    this.timeOfDay = 'afternoon';
    this.mode = 'study';
    try { if (localStorage.getItem('cuulong-mode') === 'novel') this.mode = 'novel'; } catch { /* private mode */ }
    this.credits = credits;
    this.$ = (id) => document.getElementById(id);
    this.$('langBtn').onclick = () => this.setLang(this.lang === 'vi' ? 'en' : 'vi');
    this.$('infoClose').onclick = () => this.hideInfo();
    this.$('creditsBtn').onclick = () => this.$('credits').showModal();
    this.$('menuBtn').setAttribute('aria-controls', 'sidebar');
    // phones: the menu opens the panel over the map; computers: it slides the side panel away and back (remembered)
    const phone = () => matchMedia('(max-width: 760px)').matches;
    let hidden = false;
    try { hidden = localStorage.getItem('cuulong-sidebar-hidden') === '1'; } catch { /* private mode */ }
    const applyDesk = () => {
      this.$('sidebar').classList.toggle('collapsed', hidden);
      if (!phone()) this.$('menuBtn').setAttribute('aria-expanded', String(!hidden));
    };
    applyDesk();
    this.$('menuBtn').setAttribute('aria-expanded', phone() ? 'false' : String(!hidden));
    this.$('menuBtn').onclick = () => {
      if (phone()) { const open = this.$('sidebar').classList.toggle('open'); this.$('menuBtn').setAttribute('aria-expanded', String(open)); return; }
      hidden = !hidden;
      try { localStorage.setItem('cuulong-sidebar-hidden', hidden ? '1' : '0'); } catch { /* private mode */ }
      applyDesk();
    };
    setTimeout(() => (this.$('hint').style.opacity = '0'), 12000);
  }

  t(key) { return T[this.lang][key]; }
  closeMenu() { this.$('sidebar').classList.remove('open'); this.$('menuBtn').setAttribute('aria-expanded', 'false'); }
  viewName(id, lang = this.lang) { return T[lang].view[id] || id; }

  loading(step, frac) {
    this.$('loadingText').textContent = T[this.lang].loading[step] || step;
    this.loadFraction = Math.max(this.loadFraction || 0, Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0);
    const percent = Math.round(this.loadFraction * 100);
    this.$('loadingBar').style.width = `${percent}%`;
    this.$('loadingPercent').textContent = `${percent}%`;
    this.$('loadingProgress').setAttribute('aria-valuenow', percent);
    this.$('loadingProgress').setAttribute('aria-label', T[this.lang].loading[step] || step);
    if (step === 'ready') { this.$('loading').setAttribute('aria-busy', 'false'); setTimeout(() => { this.$('loading').classList.add('done'); this.$('loading').setAttribute('aria-hidden', 'true'); }, 300); }
  }

  build({ views, sites, layers }) {
    this.views = views;
    this.sites = sites.filter((s) => ['real', 'embellished', 'fictional'].includes(s.match));
    this.layerNames = layers;
    this.layerState = Object.fromEntries(layers.map((l) => [l, true]));
    this.render();
  }

  render() {
    document.documentElement.lang = this.lang;
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const v = this.t(el.dataset.i18n);
      if (typeof v === 'string') el.textContent = v;
    }
    this.$('langBtn').textContent = this.lang === 'vi' ? 'EN' : 'VI';

    const novel = this.mode === 'novel';
    const mode = this.$('mode');
    mode.innerHTML = '';
    for (const id of ['study', 'novel']) {
      const b = document.createElement('button');
      b.textContent = T[this.lang].modes[id];
      b.className = this.mode === id ? 'on' : '';
      b.onclick = () => this.setMode(id);
      mode.append(b);
    }
    const mnote = document.createElement('p');
    mnote.className = 'seg-note';
    mnote.textContent = T[this.lang].modeNote[this.mode];
    mode.append(mnote);
    this.$('placesSection').hidden = !novel;
    this.$('aboutText').textContent = this.t(novel ? 'about' : 'about_study');

    const views = this.$('views');
    views.innerHTML = '';
    for (const id of Object.keys(this.views)) {
      if (!novel && NOVEL_VIEWS.includes(id)) continue;
      const b = document.createElement('button');
      b.textContent = T[this.lang].view[id] || id;
      b.onclick = () => { this.cb.onView(id); this.closeMenu(); };
      views.append(b);
    }

    const list = this.$('siteList');
    list.innerHTML = '';
    for (const s of this.sites) {
      const li = document.createElement('li');
      li.dataset.id = s.id; li.tabIndex = 0; li.setAttribute('role', 'button');
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); } };
      li.innerHTML = `<span class="site-id" style="background:${MATCH_COLORS[s.match]}">${s.id}</span>` +
        `<span class="site-name">${escapeHtml(this.lang === 'vi' ? s.short || s.name_vi : s.name.split(' (')[0])}</span>` +
        (s.mismatch ? '<i class="warn">!</i>' : '');
      li.onclick = () => { this.cb.onSite(s); this.closeMenu(); };
      list.append(li);
    }

    const layers = this.$('layers');
    layers.innerHTML = '';
    for (const l of this.layerNames) {
      if (!novel && NOVEL_LAYERS.includes(l)) continue;
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.layerState[l];
      cb.onchange = () => { this.layerState[l] = cb.checked; this.cb.onLayer(l, cb.checked); };
      lab.append(cb, document.createTextNode(T[this.lang].layer[l] || l));
      layers.append(lab);
    }

    const q = this.$('quality');
    if (q) {
      q.innerHTML = '';
      for (const id of ['fast', 'good', 'cinematic']) {
        const b = document.createElement('button');
        b.textContent = T[this.lang].qualityModes[id];
        b.className = this.quality === id ? 'on' : '';
        b.onclick = () => { this.quality = id; this.cb.onQuality?.(id); this.render(); };
        q.append(b);
      }
      const note = document.createElement('p');
      note.className = 'seg-note';
      note.textContent = T[this.lang].qualityNote;
      q.append(note);
    }

    const w = this.$('weather');
    if (w) {
      w.innerHTML = '';
      for (const id of ['clear', 'cloudy', 'overcast', 'rain', 'mist', 'auto']) {
        const b = document.createElement('button');
        b.textContent = T[this.lang].weatherModes[id];
        b.className = this.weather === id ? 'on' : '';
        b.setAttribute('aria-pressed', this.weather === id);
        b.onclick = () => { this.weather = id; this.cb.onWeather?.(id); this.render(); };
        w.append(b);
      }
      const note = document.createElement('p');
      note.className = 'seg-note';
      note.textContent = T[this.lang].weatherNote;
      w.append(note);
    }

    const tod = this.$('timeOfDay');
    if (tod) {
      tod.innerHTML = '';
      for (const id of ['sunrise', 'morning', 'noon', 'afternoon', 'sunset']) {
        const b = document.createElement('button');
        b.textContent = T[this.lang].timeModes[id];
        b.className = this.timeOfDay === id ? 'on' : '';
        b.setAttribute('aria-pressed', this.timeOfDay === id);
        // (render/weather.js takes the time of day through the weather hook: 'time:<id>')
        b.onclick = () => { this.timeOfDay = id; this.cb.onWeather?.('time:' + id); this.render(); };
        tod.append(b);
      }
    }

    this.$('creditsList').innerHTML = this.credits.filter((c) => novel || !isStoryCredit(c)).map((c) => `<li>${escapeHtml(c)}</li>`).join('');
    if (this.current) this.current.kind === 'site' ? this.showSite(this.current.item) : this.showLandmark(this.current.item);
    this.extras?.render();
  }

  /** 'study' (default: no novel content) or 'novel' (story places, route, notes). */
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    try { localStorage.setItem('cuulong-mode', mode); } catch { /* ignore */ }
    if (mode === 'study' && this.current && this.current.kind === 'site') this.hideInfo();
    this.render();
    this.cb.onMode?.(mode);
  }

  setLang(lang) {
    this.lang = lang;
    this.render();
    this.cb.onLang(lang);
  }

  showSite(s) {
    this.current = { kind: 'site', item: s };
    const vi = this.lang === 'vi';
    const pick = (k) => (vi ? s[`${k}_vi`] ?? s[k] : s[k]) || '';
    const badge = (cls, txt, style = '') => `<span class="badge ${cls}" style="${style}">${escapeHtml(txt)}</span>`;
    const story = ['real', 'embellished', 'fictional'].includes(s.match);
    let html = `<h3>${escapeHtml(vi ? s.name_vi || s.name : s.name)}</h3>`;
    if (story) html += `<div class="sub">${escapeHtml(s.id)}${s.short && vi ? ' · ' + escapeHtml(s.short) : ''}</div>`;
    html += '<div class="badges">' + badge('', this.t(`m_${s.match}`), `background:${MATCH_COLORS[s.match]}`) +
      (s.mismatch ? badge('warnb', '! ' + this.t('m_conflict')) : '') + '</div>';
    if (pick('canon')) html += `<h4>${this.t('canon')}</h4><p>${escapeHtml(pick('canon'))}</p>`;
    if (pick('real_note')) html += `<h4>${this.t('reality')}</h4><p class="${s.mismatch ? 'conflict' : ''}">${escapeHtml(pick('real_note'))}</p>`;
    const inv = pick('invented');
    if (inv && inv !== '—') html += `<h4>${this.t('invented')}</h4><p>${escapeHtml(inv)}</p>`;
    if (s.uncertainty_m) html += `<p class="coords">${escapeHtml(T[this.lang].uncertain(s.uncertainty_m))}</p>`;
    html += `<p class="coords">${s.lat.toFixed(5)}° N, ${s.lon.toFixed(5)}° E</p>`;
    html += `<div class="actions"><button class="chip" id="flyBtn">${this.t('fly')}</button>` +
      `<a class="chip" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=16/${s.lat}/${s.lon}">${this.t('osm')}</a></div>`;
    this.$('infoBody').innerHTML = html;
    this.$('flyBtn').onclick = () => this.cb.onSite(s);
    this.$('info').classList.remove('hidden');
    for (const li of this.$('siteList').children) li.classList.toggle('active', li.dataset.id === s.id);
  }

  showLandmark(L) {
    this.current = { kind: 'landmark', item: L };
    this.$('infoBody').innerHTML = `<h3>${escapeHtml(L.name)}</h3>` +
      `<div class="badges"><span class="badge" style="background:#7a6a4f">${escapeHtml(T[this.lang].lm[L.kind] || L.kind)}</span></div>` +
      `<p>${escapeHtml(this.t('lm_note'))}</p>`;
    this.$('info').classList.remove('hidden');
  }

  hideInfo() {
    this.current = null;
    this.$('info').classList.add('hidden');
    for (const li of this.$('siteList').children) li.classList.remove('active');
    if (new URLSearchParams(location.hash.slice(1)).has('site')) history.replaceState(null, '', location.pathname + location.search);
  }
}
