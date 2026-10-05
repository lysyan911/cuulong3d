// Original bridge/bank kit on cached OSM lines and the existing surface contour.
// A merged opaque material per cell/LOD keeps the whole layer inside 16 calls /160k triangles.
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {cloudUniforms,patchCloudShadow} from './render/atmosphere.js';
import {warm} from './render/warmup.js';

const MODEL='models/mekong-places/',DATA='data/',CELL=768,MAX_CALLS=16,MAX_TRIANGLES=160000,MAX_CACHE=24;
function profile(kind,s){
  if(kind==='monkey')return 1.6*Math.sin(Math.PI*s);
  if(kind==='rural')return 2*Math.min(1,Math.sin(Math.PI*s)/Math.sin(Math.PI*.35))**2;
  const h=kind==='vam-cong'?39.6:3,lo=kind==='vam-cong'?.35:.25;
  return h*Math.min(1,s/lo,(1-s)/lo);
}
function station(path,s){
  s=THREE.MathUtils.clamp(s,0,1);let lo=1,hi=path.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(path[mid][3]<s)lo=mid+1;else hi=mid;}const i=lo;
  const a=path[i-1],b=path[i],u=(s-a[3])/Math.max(b[3]-a[3],1e-9),dx=b[0]-a[0],dn=b[1]-a[1],L=Math.hypot(dx,dn)||1;
  return {x:a[0]+dx*u,n:a[1]+dn*u,h:a[2]+(b[2]-a[2])*u,nx:-dn/L,nn:dx/L};
}
async function json(file){const r=await fetch(file);if(!r.ok)throw Error('Mekong places unavailable: '+file);return r.json();}

export class MekongPlacesLayer{
  constructor(terrain,{mobile=false,bridges=true,banks=true,dataUrl=DATA,modelsUrl=MODEL}={}){
    this.terrain=terrain;this.mobile=mobile;this.bridges=bridges;this.banks=banks&&!mobile;this.dataUrl=dataUrl;this.modelsUrl=modelsUrl;
    this.group=new THREE.Group();this.group.name='mekong-places';
    this.bridgeGroup=new THREE.Group();this.bridgeGroup.name='mekong-bridges';this.bankGroup=new THREE.Group();this.bankGroup.name='mekong-banks';this.group.add(this.bridgeGroup,this.bankGroup);
    this.cells=new Map();this.models=new Map();this.entries=[];this.dead=false;this.ready=false;this.pending=null;this.tick=0;
    this.frustum=new THREE.Frustum();this.vp=new THREE.Matrix4();
    this.material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.88,metalness:0,side:THREE.DoubleSide});
    this.material.onBeforeCompile=sh=>patchCloudShadow(sh,cloudUniforms());this.material.customProgramCacheKey=()=> 'mekong-places-v1';
    this.stats={triangles:0,calls:0,cells:0,builtCells:0,textureBytes:0,buildMs:0,placements:0};
  }
  async load(){
    const [kit,bridges,banks]=await Promise.all([json(this.modelsUrl+'kit.json'),this.bridges?json(this.dataUrl+'mekong-bridges.json'):null,this.banks?json(this.dataUrl+'mekong-banks.json'):null]);
    if(this.dead)return;this.kit=kit;this.bridgeData=bridges;this.bankData=banks;
    if((bridges&&bridges.cell_m!==CELL)||(banks&&banks.cell_m!==CELL))throw Error('Unsupported Mekong places cell size');
    const records=[...(bridges?.placements||[]).map(r=>({...r,kind:'bridges'})),...(banks?.placements||[]).map(r=>({...r,kind:r.model==='landing'?'landings':'banks'}))];this.stats.placements=records.length;
    const needed=new Set(records.map(r=>r.model));if(records.some(r=>r.piers?.length))needed.add('pier');const loader=new GLTFLoader();
    for(const model of kit.models){
      if(!needed.has(model.id))continue;
      for(const lod of ['near','far']){
        const a=model[lod];if(!a)continue;
        const gltf=await loader.loadAsync(this.modelsUrl+a.file);gltf.scene.updateMatrixWorld(true);const geometries=[];
        gltf.scene.traverse(o=>{if(o.isMesh){const g=o.geometry.clone().applyMatrix4(o.matrixWorld);for(const key of Object.keys(g.attributes))if(!['position','normal','color','uv'].includes(key))g.deleteAttribute(key);geometries.push(g);o.geometry.dispose();const materials=Array.isArray(o.material)?o.material:[o.material];materials.forEach(m=>m.dispose());}});
        if(this.dead){geometries.forEach(g=>g.dispose());return;}
        const g=mergeGeometries(geometries,false);geometries.forEach(g=>g.dispose());if(!g)throw Error('Mekong kit attributes differ');
        this.models.set(model.id+'-'+lod,{geometry:g,reference:model.reference,triangles:a.triangles});
      }
    }
    const grouped=new Map();
    for(const r of records){const key=r.kind+':'+r.cell;if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(r);}
    for(const [key,rows] of grouped){
      const [cx,cn]=rows[0].cell.split('_').map(Number);const centre=new THREE.Vector3((cx+.5)*CELL,0,-(cn+.5)*CELL),box=new THREE.Box3();
      for(const r of rows){for(const p of r.path)box.expandByPoint(new THREE.Vector3(p[0],p[2]*this.terrain.ex,-p[1]));if(r.model==='vam-cong')box.max.y+=145*this.terrain.ex;else box.max.y+=9*this.terrain.ex;}
      box.expandByScalar(Math.max(...rows.map(r=>r.width||4))*.6+4);
      this.entries.push({key,rows,kind:rows[0].kind,centre,box,last:0});
    }
    // Standard opaque meshes need only this shared shader variant warmed once.
    const first=this.models.values().next().value;
    if(first){const probes=new THREE.Group(),near=new THREE.Mesh(first.geometry,this.material),bulk=new THREE.Mesh(first.geometry,this.material);bulk.userData.noShadow=true;probes.add(near,bulk);await warm(probes);}
    if(!this.dead)this.ready=true;
  }
  *deform(r,lod,centre){
    const source=this.models.get(r.model+'-'+lod)||this.models.get(r.model+'-near');if(!source)return null;
    const g=source.geometry.clone(),pos=g.getAttribute('position'),marker=g.getAttribute('uv'),ref=source.reference,ex=this.terrain.ex;
    const endpointShift=r.kind==='bridges'?r.path.filter((p,i)=>i===0||i===r.path.length-1).map((p,i)=>this.terrain.heightAt(p[0],p[1])*ex-p[2]*ex+.08*ex):[0,0];
    let finished=false;const stations=new Map();
    try{for(let i=0;i<pos.count;i++){
      if(i&&i%1200===0)yield;
      const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i),s0=THREE.MathUtils.clamp(z/ref.length+.5,0,1);
      const structure=r.model==='vam-cong'&&marker?.getX(i)>.5;
      const s=structure?s0+(r.structure_centre-.5):s0;let p=stations.get(s);
      if(!p){p=station(r.path,s);if(r.kind!=='bridges'){const dry=r.house_floor_sample||[p.x-p.nx*2.5,p.n-p.nn*2.5],land=this.terrain.heightAt(dry[0],dry[1])*ex+(r.house_floor_sample ? .15 : 0),level=this.terrain.surface?.waterHeight(p.x,p.n)??r.water_level*ex;p.land=land;p.bank=Math.max(.3,land-level)/1.6;}stations.set(s,p);}
      let across=x,up;
      if(r.kind==='bridges'){
        across=x*r.width/ref.width;up=y-profile(ref.profile,s0)+p.h;
        // Meet the actual runtime bank elevation only on the access ramps; keep the
        // documented/estimated navigation crown and waterline unchanged.
        const divisions=r.model==='vam-cong'?100:24;
        const ramp0=Math.max(.001,Math.floor(r.wet[0]*divisions)/divisions),ramp1=Math.max(.001,1-Math.ceil(r.wet[1]*divisions)/divisions);
        up=up*ex+endpointShift[0]*Math.max(0,1-s/ramp0)+endpointShift[1]*Math.max(0,1-(1-s)/ramp1);
      }else{
        across=x*(r.depth_scale??1)+(r.depth_offset??0);
        up=p.land+(y<0?y*p.bank:y);
      }
      pos.setXYZ(i,p.x+p.nx*across-centre.x,up,-p.n-p.nn*across-centre.z);
    }
    g.deleteAttribute('uv');g.computeVertexNormals();g.computeBoundingBox();finished=true;return g;
    }finally{if(!finished)g.dispose();}
  }
  pier(r,row,centre){
    const source=this.models.get('pier-near');if(!source)return null;const g=source.geometry.clone(),p=g.getAttribute('position'),q=station(r.path,row[4]),ex=this.terrain.ex;
    const bottom=Math.min(this.terrain.heightAt(row[0],row[1])*ex,this.terrain.surface?.waterHeight(row[0],row[1])??row[2]*ex)-.35*ex,top=row[3]*ex;
    for(let i=0;i<p.count;i++){const across=p.getX(i)*r.width*.72,along=p.getZ(i)*Math.max(.8,r.width*.1);p.setXYZ(i,row[0]+q.nx*across+q.nn*along-centre.x,bottom+p.getY(i)*(top-bottom),-row[1]-q.nn*across+q.nx*along-centre.z);}
    g.deleteAttribute('uv');g.computeVertexNormals();return g;
  }
  *build(entry){
    const group=new THREE.Group();group.position.copy(entry.centre);group.userData.occBox=entry.box.clone();group.name=entry.key;
    const meshes=[];let parts=[],published=false;
    try{
    for(const lod of ['near','far']){
      parts=[];
      for(const r of entry.rows){const g=yield* this.deform(r,lod,entry.centre);if(g)parts.push(g);for(const row of r.piers||[]){const p=this.pier(r,row,entry.centre);if(p)parts.push(p);}yield;}
      if(this.dead)return null;
      const geometry=mergeGeometries(parts,false);parts.forEach(g=>g.dispose());parts=[];if(!geometry)continue;
      geometry.computeBoundingBox();geometry.computeBoundingSphere();const mesh=new THREE.Mesh(geometry,this.material);mesh.name=entry.key+'-'+lod;mesh.userData.noShadow=lod==='far'||entry.kind==='banks';mesh.visible=false;mesh.frustumCulled=true;group.add(mesh);meshes.push({mesh,lod,triangles:geometry.index?geometry.index.count/3:geometry.attributes.position.count/3});
      yield;
    }
    group.visible=false;(entry.kind==='bridges'?this.bridgeGroup:this.bankGroup).add(group);
    published=true;
    return {entry,group,meshes,last:this.tick};
    }finally{parts.forEach(g=>g.dispose());if(!published)meshes.forEach(p=>p.mesh.geometry.dispose());}
  }
  update(camera){
    if(!this.ready||this.dead)return;this.tick++;const start=performance.now();
    this.vp.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);this.frustum.setFromProjectionMatrix(this.vp);
    const wanted=this.entries.map(e=>({e,d:e.box.distanceToPoint(camera.position)})).filter(v=>v.d<(v.e.kind==='bridges'?2400:650)&&this.frustum.intersectsBox(v.e.box)).sort((a,b)=>a.d-b.d);
    if(!this.pending){const item=wanted.find(v=>!this.cells.has(v.e.key));if(item)this.pending={entry:item.e,steps:this.build(item.e)};}
    if(this.pending){let r;do{r=this.pending.steps.next();if(r.done){if(r.value)this.cells.set(this.pending.entry.key,r.value);this.pending=null;break;}}while(performance.now()-start<2.5);}
    let tri=0,calls=0,cells=0;for(const c of this.cells.values()){c.group.visible=false;c.meshes.forEach(m=>m.mesh.visible=false);}
    for(const {e,d} of wanted){const cell=this.cells.get(e.key);if(!cell)continue;cell.last=this.tick;const lod=this.mobile?'far':d<(e.kind==='bridges'?450:200)?'near':'far';const part=cell.meshes.find(p=>p.lod===lod)||cell.meshes[0];
      if(!part||calls>=MAX_CALLS||tri+part.triangles>MAX_TRIANGLES)continue;cell.group.visible=true;part.mesh.visible=true;tri+=part.triangles;calls++;cells++;
    }
    if(this.cells.size>MAX_CACHE){const old=[...this.cells.values()].filter(c=>!c.group.visible).sort((a,b)=>a.last-b.last);for(const c of old){if(this.cells.size<=MAX_CACHE)break;c.group.removeFromParent();c.meshes.forEach(p=>p.mesh.geometry.dispose());this.cells.delete(c.entry.key);}}
    Object.assign(this.stats,{triangles:tri,calls,cells,builtCells:this.cells.size,buildMs:performance.now()-start});
  }
  dispose(){
    this.dead=true;this.ready=false;this.pending?.steps.return();this.pending=null;
    for(const cell of this.cells.values())cell.meshes.forEach(p=>p.mesh.geometry.dispose());this.cells.clear();
    for(const source of this.models.values())source.geometry.dispose();this.models.clear();this.material.dispose();this.group.clear();this.group.removeFromParent();
  }
}
