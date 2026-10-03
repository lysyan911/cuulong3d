// Raised earth bunds near the camera. Rice colour/rows are shaded on the terrain at every LOD.
import * as THREE from 'three';
import { FIELD,fieldPoint,fieldCoords } from './surface.js';

const TILE=512,MAX_TILES=24;
export class PaddyLayer {
  constructor(terrain,{nearR=1150}={}) {
    this.terrain=terrain;this.surface=terrain.surface;this.nearR=nearR;
    this.group=new THREE.Group();this.group.name='paddies';
    this.material=new THREE.MeshStandardMaterial({color:0x667343,roughness:1,flatShading:true});
    this.tiles=new Map();this.frame=0;
  }
  build(tx,ty) {
    const x0=tx*TILE,y0=ty*TILE,positions=[],indices=[],seen=new Set();
    const corners=[[x0,y0],[x0+TILE,y0],[x0,y0+TILE],[x0+TILE,y0+TILE]].map(([x,y])=>fieldCoords(x,y));
    const minU=Math.floor(Math.min(...corners.map(p=>p[0]))/FIELD.width)-1;
    const maxU=Math.ceil(Math.max(...corners.map(p=>p[0]))/FIELD.width)+1;
    const minV=Math.floor(Math.min(...corners.map(p=>p[1]))/FIELD.depth)-1;
    const maxV=Math.ceil(Math.max(...corners.map(p=>p[1]))/FIELD.depth)+1;
    const surface=this.surface,terrain=this.terrain,ex=terrain.ex;
    const height=(x,y)=>terrain.heightAt(x,y)*ex;
    const addRidge=(a,b,key)=>{
      if(seen.has(key))return;
      const mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2;
      if(Math.floor(mx/TILE)!==tx || Math.floor(my/TILE)!==ty)return;
      seen.add(key);
      const len=Math.hypot(b[0]-a[0],b[1]-a[1]),steps=Math.ceil(len/24);
      const nx=-(b[1]-a[1])/len,ny=(b[0]-a[0])/len;
      for(let i=0;i<steps;i++) {
        const ring=(t)=>{
          const x=a[0]+(b[0]-a[0])*t,y=a[1]+(b[1]-a[1])*t,h=height(x,y);
          return [[x-nx*1.5,h+.04,-y+ny*1.5],[x-nx*.6,h+FIELD.bundHeight*ex,-y+ny*.6],
                  [x+nx*.6,h+FIELD.bundHeight*ex,-y-ny*.6],[x+nx*1.5,h+.04,-y-ny*1.5]];
        };
        const aR=ring(i/steps),bR=ring((i+1)/steps),base=positions.length/3;
        for(const p of [...aR,...bR])positions.push(...p);
        for(let j=0;j<3;j++)indices.push(base+j,base+j+4,base+j+1,base+j+1,base+j+4,base+j+5);
      }
    };
    for(let i=minU;i<maxU;i++)for(let j=minV;j<maxV;j++) {
      const u=i*FIELD.width,v=j*FIELD.depth;
      const checks=[[.1,.1],[.9,.1],[.1,.9],[.9,.9],[.5,.5],[.5,.1],[.5,.9],[.1,.5],[.9,.5]];
      const pts=checks.map(([a,b])=>fieldPoint(u+a*FIELD.width,v+b*FIELD.depth));
      if(!pts.every(([x,y])=>surface.cropAt(x,y)>.8 && (!terrain.wetland || terrain.wetland.floodAt(x,y)<.2) && surface.waterAt(x,y)<.2 && surface.shoreAt(x,y)>25))continue;
      const h=pts.map(([x,y])=>height(x,y));
      if(Math.max(...h)-Math.min(...h)>5)continue;
      const p=[fieldPoint(u,v),fieldPoint(u+FIELD.width,v),fieldPoint(u+FIELD.width,v+FIELD.depth),fieldPoint(u,v+FIELD.depth)];
      addRidge(p[0],p[1],`h${i},${j}`);addRidge(p[3],p[2],`h${i},${j+1}`);
      addRidge(p[0],p[3],`v${i},${j}`);addRidge(p[1],p[2],`v${i+1},${j}`);
    }
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geo.setIndex(indices);geo.computeVertexNormals();geo.computeBoundingSphere();
    const mesh=new THREE.Mesh(geo,this.material);mesh.raycast=()=>{};
    this.group.add(mesh);return {mesh,used:this.frame};
  }
  update(camera) {
    if(!this.group.visible || !this.surface)return;
    this.frame++;
    const p=camera.position,R=this.nearR,candidates=[];
    for(const entry of this.tiles.values())entry.mesh.visible=false;
    for(let tx=Math.floor((p.x-R)/TILE);tx<=Math.floor((p.x+R)/TILE);tx++)
      for(let ty=Math.floor((-p.z-R)/TILE);ty<=Math.floor((-p.z+R)/TILE);ty++) {
        const x=(tx+.5)*TILE,y=(ty+.5)*TILE;
        const ground=this.terrain.heightAt(x,y)*this.terrain.ex;
        const d=Math.hypot(Math.max(Math.abs(x-p.x)-TILE/2,0),Math.max(Math.abs(y+p.z)-TILE/2,0),p.y-ground);
        if(d<R)candidates.push({tx,ty,d});
      }
    candidates.sort((a,b)=>a.d-b.d);
    let built=0;
    for(const {tx,ty} of candidates.slice(0,MAX_TILES)) {
      const key=`${tx}_${ty}`;let entry=this.tiles.get(key);
      if(!entry && built<1) {entry=this.build(tx,ty);this.tiles.set(key,entry);built++;}
      if(entry){entry.mesh.visible=true;entry.used=this.frame;}
    }
    if(this.tiles.size>MAX_TILES) {
      const old=[...this.tiles.entries()].filter(([,t])=>!t.mesh.visible).sort((a,b)=>a[1].used-b[1].used);
      for(const [key,t] of old.slice(0,this.tiles.size-MAX_TILES)){this.group.remove(t.mesh);t.mesh.geometry.dispose();this.tiles.delete(key);}
    }
  }
}
