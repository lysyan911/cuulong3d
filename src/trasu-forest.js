// Original reference-led forest assets, CPU instance LOD and wildlife. Water belongs to trasu.js.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { hash, nearestPath } from './wetland-map.js';
import { GLOBALS } from './render/globals.js';
import { cloudUniforms, patchCloudShadow } from './render/atmosphere.js';

const NEAR=110,MID=650,PLANTS=125;
const MAX_CANAL_TRIANGLES=295000,MAX_AIR_TRIANGLES=1100000;
const dummy=new THREE.Object3D(),color=new THREE.Color();

function forestMaterial(texture,time) {
  const mat=new THREE.MeshLambertMaterial({map:texture,vertexColors:true,alphaTest:.30,side:THREE.DoubleSide});
  const wind=sh=>{
    sh.uniforms.uTime=time;sh.uniforms.uViewPos=GLOBALS.uViewPos;
    sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nattribute float _wind; uniform float uTime; varying float vLeaf;')
      .replace('#include <begin_vertex>',`#include <begin_vertex>
        vLeaf=step(.9,_wind);
        vec4 root=instanceMatrix*vec4(0.,0.,0.,1.);
        float phase=root.x*.17+root.z*.11;
        transformed.x+=_wind*sin(uTime*.8+phase+position.y*.19)*.055;
        transformed.z+=_wind*sin(uTime*.6+phase)*.035;`);
    // Preserve the coverage of small lanceolate leaves as the atlas mip level increases.
    sh.fragmentShader=sh.fragmentShader
      .replace('#include <common>','#include <common>\nvarying float vLeaf;')
      .replace('#include <normal_fragment_begin>',`#include <normal_fragment_begin>
        if(vLeaf>.5)normal=normalize(vNormal);`)
      .replace('#include <alphatest_fragment>',`
      float leafMip=max(0.,log2(max(fwidth(vMapUv.x),fwidth(vMapUv.y))*2048.));
      diffuseColor.a=min(1.,diffuseColor.a*(1.+.45*leafMip));
      #include <alphatest_fragment>`);
  };
  mat.onBeforeCompile=sh=>{wind(sh);patchCloudShadow(sh,cloudUniforms());};
  mat.customProgramCacheKey=()=> 'trasu-sprigs-v2';
  const depth=new THREE.MeshDepthMaterial({map:texture,alphaTest:.30,side:THREE.DoubleSide,depthPacking:THREE.RGBADepthPacking});
  depth.onBeforeCompile=wind;depth.customProgramCacheKey=()=> 'trasu-sprigs-depth-v2';
  mat.userData.depthMaterial=depth;return mat;
}

export class TraSuForest {
  constructor(layer) {
    this.layer=layer;this.map=layer.map;this.treeGroup=layer.treeGroup;this.detail=layer.detail;
    this.pools=new Map();this.models=new Map();this.last=new THREE.Vector3(Infinity,0,0);this.lastDirection=new THREE.Vector3();
    this.frustum=new THREE.Frustum();this.matrix=new THREE.Matrix4();this.sphere=new THREE.Sphere();
  }
  async load() {
    const [gltf,kit]=await Promise.all([new GLTFLoader().loadAsync('models/trasu-forest/forest.glb'),fetch('models/trasu-forest/kit.json').then(r=>r.json())]);
    this.kit=kit;gltf.scene.traverse(o=>{if(o.isMesh)this.models.set(o.name,o.geometry);});
    const first=gltf.scene.children.find(o=>o.isMesh);this.material=forestMaterial(first.material.map,this.layer.shared.uTime);
    this.material.map.anisotropy=4;
    for(const m of kit.models) {
      const far=['mid','far','bird-far'].includes(m.kind),capacity=m.kind==='near'?800:m.kind==='mid'?14000:m.kind==='far'?60000:3000;
      const mesh=new THREE.InstancedMesh(this.models.get(m.id),this.material,capacity);mesh.name=m.id;mesh.count=0;mesh.visible=false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.raycast=()=>{};
      if(far)mesh.userData.noShadow=true;
      (['near','mid','far'].includes(m.kind)?this.treeGroup:this.detail).add(mesh);
      this.pools.set(m.id,{mesh,meta:m,capacity,count:0});
    }
    this.trees=this.map.generateTrees(this.layer.mobile?15:11);this.layer.records=this.trees;
    this.treeBins=new Map();
    for(const p of this.trees) {
      const key=`${Math.floor(p.x/80)},${Math.floor(p.z/80)}`;if(!this.treeBins.has(key))this.treeBins.set(key,[]);this.treeBins.get(key).push(p);
    }
    this.makeEcology();
    const perch=this.birds.filter(p=>p.id==='egret-perched' && Math.hypot(p.x+240,p.z-210)<70).sort((a,b)=>b.y-a.y)[0];
    if(perch) {
      const v=this.layer.views.trasuBirds,c=this.map.centre;
      v.target.set(c[0]+perch.x,perch.y+.45,c[1]+perch.z);
      v.pos.set(c[0]+perch.x+5,perch.y+3.5,c[1]+perch.z+7);
    }
    this.ready=true;
  }
  makeEcology() {
    this.birds=[];this.plants=[];
    const walk=[{points:this.map.data.boardwalk,width:2.2}];
    const nearMeta=this.kit.models.filter(m=>m.kind==='near');
    for(let i=0;i<this.trees.length;i++) {
      const p=this.trees[i],colony=Math.hypot(p.x+240,p.z-210)<95;
      if(p.form && hash(i,90)<(colony?.20:.026)) {
        const perch=nearMeta[p.form].perches[i%2],c=Math.cos(p.angle),s=Math.sin(p.angle);
        const white=hash(i,91)<.78;
        this.birds.push({x:p.x+(c*perch[0]+s*perch[2])*p.scale,z:p.z+(-s*perch[0]+c*perch[2])*p.scale,
          y:this.map.level-.10+perch[1]*p.scale+.035,angle:hash(i,92)*6.28,scale:.88+hash(i,93)*.25,
          id:white?'egret-perched':hash(i,94)<.30?'cormorant-drying':'cormorant-perched',white});
      }
      // A few waders in sheltered duckweed along the channel, not the open navigation lane.
      if(p.edge>3 && p.edge<16 && hash(i,95)<.018 && this.map.sampleLocal(p.x+1,p.z)>.98 && nearestPath(p.x+1,p.z,walk).distance>2.2) this.birds.push({x:p.x+1,z:p.z,y:this.map.level+.015,
        angle:hash(i,96)*6.28,scale:.9,id:'egret-wading',white:true});
      // Aquatic edges follow the whole channel network and mapped forest edge, not two planted circles.
      if(hash(i,97)>.32)continue;
      const x=p.x+2.3,z=p.z-1.3,cover=this.map.sampleLocal(x,z,1),path=nearestPath(x,z,this.map.data.channels),edge=path.distance-path.width*.5;
      if(this.map.sampleLocal(x,z)<.98 || edge<2 || !(edge<13 || cover<.6))continue;
      for(let j=0;j<2;j++) {
        const px=x+(hash(i,j,98)-.5)*4,pz=z+(hash(i,j,99)-.5)*4;
        const nearby=nearestPath(px,pz,this.map.data.channels);
        if(this.map.sampleLocal(px,pz)<.98 || nearby.distance<nearby.width*.5+1.2 || nearestPath(px,pz,walk).distance<2.2)continue;
        const h=hash(i,j,100);this.plants.push({x:px,z:pz,y:this.map.level+.05,angle:hash(i,j,101)*6.28,scale:.8+hash(i,j,102)*.6,
          id:h<.43?'water-fern':h<.73?'water-lilies':h<.83?'lotus':'reeds'});
      }
    }
  }
  visible(p,height,radius) {
    this.sphere.center.set(this.map.centre[0]+p.x,(p.y??this.map.level)+height,this.map.centre[1]+p.z);this.sphere.radius=radius;
    return this.frustum.intersectsSphere(this.sphere);
  }
  add(id,p,scaleY=p.scale) {
    const pool=this.pools.get(id);if(!pool||pool.count===pool.capacity||this.triangles+pool.meta.triangles>this.budget)return false;
    dummy.position.set(p.x,p.y??this.map.level-.10,p.z);dummy.rotation.set(0,p.angle,0);dummy.scale.set(p.scale,scaleY,p.scale);dummy.updateMatrix();
    pool.mesh.setMatrixAt(pool.count,dummy.matrix);const t=p.tint??1;color.setRGB(t,t,t);pool.mesh.setColorAt(pool.count,color);
    pool.count++;this.triangles+=pool.meta.triangles;return true;
  }
  update(camera) {
    if(!this.ready)return;
    const local=camera.position.clone().sub(this.layer.group.position),direction=camera.getWorldDirection(new THREE.Vector3());
    const projection=camera.projectionMatrix.elements.join(',');
    if(local.distanceToSquared(this.last)<9 && direction.dot(this.lastDirection)>.9995 && projection===this.lastProjection)return;
    this.lastProjection=projection;
    this.last.copy(local);this.lastDirection.copy(direction);
    this.matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);this.frustum.setFromProjectionMatrix(this.matrix);
    const immersive=local.y<this.map.level+80,nearRadius=this.layer.mobile?80:NEAR;
    this.budget=immersive?MAX_CANAL_TRIANGLES:MAX_AIR_TRIANGLES;this.triangles=0;
    for(const pool of this.pools.values())pool.count=0;
    const near=[],mid=[],far=[];
    // Coarse bins avoid scanning the whole wetland while paddling along a canal.
    const candidates=immersive?[]:this.trees;
    if(immersive)for(let z=Math.floor((local.z-MID-25)/80);z<=Math.floor((local.z+MID+25)/80);z++)for(let x=Math.floor((local.x-MID-25)/80);x<=Math.floor((local.x+MID+25)/80);x++)candidates.push(...(this.treeBins.get(`${x},${z}`)||[]));
    const heights=[7.2,14.5,13.5,12.8,15.5,17];
    for(const p of candidates) {
      if(!this.visible(p,heights[p.form]*p.scale*.5,13*p.scale))continue;
      const distance=Math.hypot(p.x-local.x,p.z-local.z,Math.max(0,local.y-this.map.level-12));
      if(distance<nearRadius)near.push([p,distance]);else if(distance<MID)mid.push([p,distance]);else if(!immersive)far.push([p,distance]);
    }
    near.sort((a,b)=>a[1]-b[1]);mid.sort((a,b)=>a[1]-b[1]);
    for(const [p] of near)this.add(`tram-near-${p.form}`,p);
    // Reserve space for local wildlife and shore plants before filling the distant trees.
    for(const p of this.birds) {
      const d=Math.hypot(p.x-local.x,p.z-local.z,p.y-local.y);if(d>(immersive?900:5000)||!this.visible(p,.5,1.5))continue;
      this.add(d<110?p.id:p.white?'bird-far-white':'bird-far-dark',p);
    }
    if(immersive)for(const p of this.plants)if(Math.hypot(p.x-local.x,p.z-local.z)<PLANTS && this.visible(p,.6,2))this.add(p.id,p);
    for(const [p] of mid)this.add(`tram-mid-${p.form===2?1:p.form===3?2:0}`,p,p.scale*heights[p.form]/14);
    for(const [p] of far)this.add(`tram-far-${p.form%3}`,p,p.scale*heights[p.form]/14);
    let calls=0;
    for(const pool of this.pools.values()) {
      const m=pool.mesh;m.count=pool.count;m.visible=pool.count>0;
      if(m.visible){calls++;m.instanceMatrix.needsUpdate=true;m.instanceColor.needsUpdate=true;m.computeBoundingSphere();}
    }
    this.layer.nearMeshes=[...this.pools.values()].filter(p=>p.meta.kind==='near').map(p=>p.mesh);
    this.stats={triangles:this.triangles,calls,near:near.length,mid:mid.length,far:far.length,trees:this.trees.length,
      canopyBirds:this.birds.filter(p=>p.id!=='egret-wading').length,waders:this.birds.filter(p=>p.id==='egret-wading').length,edgePlants:this.plants.length};
  }
}
