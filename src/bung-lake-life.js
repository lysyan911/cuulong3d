// Original static lake assets; researched instance roots, no water or actor simulation.
import * as THREE from 'three';

export class BungLakeLife {
  constructor(parent, library, Instanced, terrain, data) {
    this.lib = library; this.Instanced = Instanced; this.terrain = terrain; this.data = data;
    this.group = new THREE.Group(); this.group.name = 'bung-lake-life'; parent.add(this.group);
    this.instances = new Map(); this.active = new Map(); this.stats = { triangles: 0, calls: 0, rafts: 0, poles: 0, boats: 0 };
    this.last = new THREE.Vector3(Infinity, Infinity, Infinity); this.frame = 0; this.retry = true;
  }
  matrix(r, stake = false) {
    const e = new THREE.Euler(stake ? r.lean_x_rad : 0, stake ? 0 : -r.heading_rad, stake ? r.lean_z_rad : 0, 'YXZ');
    return new THREE.Matrix4().compose(new THREE.Vector3(r.x, r.level_m, -r.north),
      new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(stake ? r.diameter_scale : (r.scale_x || 1), stake ? r.height_m : 1, stake ? r.diameter_scale : (r.scale_z || 1)));
  }
  update(camera) {
    if (!this.group.visible || !this.group.parent.visible) return;
    if (++this.frame % 12 && !this.retry && this.last.distanceToSquared(camera.position) < 16) return;
    this.last.copy(camera.position); this.retry = false;
    const p = camera.position, out = new Map(), lod = this.data.lods;
    const append = (id, r, stake = false) => {
      if (!out.has(id)) out.set(id, []); out.get(id).push(this.matrix(r, stake));
    };
    const dist = r => Math.hypot(r.x - p.x, r.north + p.z, p.y - r.level_m);
    for (const r of this.data.rafts) {
      const d = dist(r); if (d > lod.max_m) { this.active.delete(r.evidence_id); continue; }
      const previous = this.active.get(r.evidence_id), near = lod.near_m + (previous === r.model ? 20 : -20);
      const middle = lod.mid_m + (previous?.endsWith('-mid') ? 25 : -25);
      const want = d < near ? r.model : d < middle ? r.model + '-mid' : 'bung-raft-0-grey-lod';
      const ready = this.lib.get(want); if (!ready) this.retry = true;
      const id = ready ? want : previous; if (!id) continue;
      this.active.set(r.evidence_id, id);
      append(id, id.endsWith('-lod') ? { ...r, scale_x: r.width_m / 3.8, scale_z: r.length_m / 5.4 } : r);
    }
    for (const r of this.data.poles) if (dist(r) < lod.pole_max_m)
      append(dist(r) < lod.near_m ? 'bung-stake' : 'bung-stake-mid', r, true);
    for (const r of this.data.boats) if (dist(r) < lod.boat_max_m) append(r.model, r);
    for (const [id, matrices] of out) {
      if (this.instances.has(id)) continue;
      const model = this.lib.get(id);
      if (!model) { this.retry = true; continue; }
      const it = new this.Instanced(model, 128, this.group);
      for (const m of it.meshes) {
        m.name = id === 'canal-access/moored-blue-sampan' ? 'bung-moored-sampan' : id.startsWith('bung-stake') ? 'bung-lake-stakes' : 'bung-lake-rafts';
        m.userData.bungLakeLife = true; m.userData.noShadow = id.endsWith('-lod');
      }
      this.instances.set(id, it);
    }
    this.stats = { triangles: 0, calls: 0, rafts: 0, poles: 0, boats: 0 };
    for (const [id, it] of this.instances) {
      const matrices = out.get(id) || []; it.set(matrices);
      if (!matrices.length) continue;
      this.stats[id.startsWith('bung-raft') ? 'rafts' : id.startsWith('bung-stake') ? 'poles' : 'boats'] += matrices.length;
      for (const m of it.meshes) {
        this.stats.calls++; this.stats.triangles += (m.geometry.index?.count || m.geometry.attributes.position.count) / 3 * m.count;
      }
    }
  }
}
