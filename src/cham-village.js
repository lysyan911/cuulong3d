// Original Cham kit; bounded traced roofs and representative craft displays.
import * as THREE from 'three';

export class ChamVillage {
  constructor(parent, library, Instanced, meta, data) {
    Object.assign(this, { lib: library, Instanced, meta, data });
    this.group = new THREE.Group(); this.group.name = 'da-phuoc-village'; parent.add(this.group);
    this.instances = new Map(); this.active = new Map(); this.capacity = new Map();
    this.retry = true; this.frame = 0; this.last = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.stats = { triangles: 0, calls: 0, houses: 0, looms: 0, tools: 0, displays: 0 };
    for (const r of data.instances) for (const id of new Set([r.model, r.mid_model || r.model + '-mid', r.far].filter(Boolean))) {
      this.capacity.set(id, (this.capacity.get(id) || 0) + 1);
      this.lib.get(id); // Warm fallback LODs before an expanded mask becomes visible.
    }
  }
  matrix(r) {
    const yaw = Math.atan2(Math.cos(r.front), -Math.sin(r.front));
    return new THREE.Matrix4().compose(new THREE.Vector3(r.x, r.level_m * this.meta.vert_exag, -r.north),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
      new THREE.Vector3(r.scale_x || 1, this.meta.vert_exag, r.scale_z || 1));
  }
  update(camera) {
    if (!this.group.visible || !this.group.parent.visible) return;
    if (++this.frame % 12 && !this.retry && this.last.distanceToSquared(camera.position) < 4) return;
    this.last.copy(camera.position); this.retry = false;
    const out = new Map(), p = camera.position, candidates = [];
    for (const r of this.data.instances) {
      const d = Math.hypot(r.x - p.x, r.north + p.z, r.level_m * this.meta.vert_exag - p.y);
      const previous = this.active.get(r.id), margin = r.kind === 'house' ? 15 : 3;
      candidates.push({ r, d, previous, near: r.near_m + (previous === r.model ? margin : -margin) });
    }
    // Limit actual detailed instances, including loading fallbacks, rather than model IDs.
    const detailed = new Set();
    for (const [group, limit] of Object.entries(this.data.nearLimits || {})) {
      const eligible = candidates.filter(c => c.r.detail_group === group && c.d <= c.r.max_m && c.d < c.near);
      eligible.sort((a, b) => (a.d - (a.previous === a.r.model ? 5 : 0)) - (b.d - (b.previous === b.r.model ? 5 : 0)) || a.r.id.localeCompare(b.r.id));
      for (const c of eligible.slice(0, limit)) detailed.add(c.r.id);
    }
    for (const { r, d, previous, near } of candidates) {
      if (d > r.max_m) { this.active.delete(r.id); continue; }
      const mid = r.mid_model || r.model + '-mid';
      const middle = r.mid_m + (previous === mid ? (r.kind === 'house' ? 15 : 3) : -(r.kind === 'house' ? 15 : 3));
      const allowNear = !r.detail_group || detailed.has(r.id);
      const want = r.near_only || (d < near && allowNear) ? r.model : d < middle ? mid : r.far;
      if (!want) { this.active.delete(r.id); continue; }
      const ready = this.lib.get(want); if (!ready) this.retry = true;
      const safePrevious = previous === r.model && !allowNear ? null : previous;
      const fallback = safePrevious || (this.lib.get(mid) ? mid : r.far && this.lib.get(r.far) ? r.far : null);
      const id = ready ? want : fallback; if (!id) { this.active.delete(r.id); continue; }
      this.active.set(r.id, id);
      if (!out.has(id)) out.set(id, []); out.get(id).push(this.matrix(r));
    }
    for (const [id] of out) {
      if (this.instances.has(id)) continue;
      const model = this.lib.get(id); if (!model) { this.retry = true; continue; }
      const it = new this.Instanced(model, this.capacity.get(id), this.group);
      for (const m of it.meshes) {
        m.name = id.startsWith('da-phuoc-house-') ? 'da-phuoc-stilt-houses' : 'da-phuoc-weaving-tools';
        m.userData.daPhuoc = true; m.userData.noShadow = id.endsWith('-lod');
      }
      this.instances.set(id, it);
    }
    this.stats = { triangles: 0, calls: 0, houses: 0, looms: 0, tools: 0, displays: 0 };
    for (const [id, it] of this.instances) {
      const matrices = out.get(id) || []; it.set(matrices); if (!matrices.length) continue;
      const kind = id.startsWith('da-phuoc-house-') ? 'houses' : id.startsWith('da-phuoc-loom-') ? 'looms' : id.startsWith('da-phuoc-tools-') ? 'tools' : 'displays';
      this.stats[kind] += matrices.length;
      for (const m of it.meshes) { this.stats.calls++; this.stats.triangles += (m.geometry.index?.count || m.geometry.attributes.position.count) / 3 * m.count; }
    }
  }
}
