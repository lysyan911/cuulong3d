// Province-wide birds and surface fish. Local data is estimated habitat decoration, not a wildlife census.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {fieldStage,fieldPatch,blockLayout,FIELD} from './surface.js';
import {patchCloudShadow,cloudUniforms} from './render/atmosphere.js';
import {FaunaEffects} from './fauna-effects.js';
// Field stage on the CPU (surface.js twin of the terrain shader). It can differ from the GPU by ~0.009, so animals
// keep a margin from the stage boundaries instead of reading the GPU back (a synchronous readback costs 10-20 ms,
// a dropped frame each time a tile loads).
const FIELD_MARGIN=.025;
const CPU_FIELDS={classify:p=>{const out=new Float32Array(p.length/2);for(let i=0;i<out.length;i++)out[i]=fieldStage(p[i*2],p[i*2+1])*255;return out;},dispose(){}};
const ROOT=new URL('../models/fauna/',import.meta.url).href,DATA=new URL('../data/fauna/',import.meta.url).href;
const vertex=`
attribute float aVat;
attribute vec4 aClip;
uniform sampler2D uFaunaPosition;
uniform sampler2D uFaunaNormal;
uniform vec2 uFaunaSize;
uniform float uFaunaTime;
vec3 faunaSample(sampler2D tex) {
  float t=uFaunaTime/aClip.z+aClip.w;
  float frame=(aClip.y>0.5?fract(t):clamp(t,0.0,0.9375))*16.0;
  vec2 q=vec2(aVat,(aClip.x+floor(frame)+0.5)/uFaunaSize.y);
  float nextFrame=aClip.y>0.5?mod(floor(frame)+1.0,16.0):min(15.0,floor(frame)+1.0);
  vec2 r=vec2(aVat,(aClip.x+nextFrame+0.5)/uFaunaSize.y);
  return mix(texture2D(tex,q).xyz,texture2D(tex,r).xyz,fract(frame));
}`;
async function vat(base,file,w,h){
  const r=await fetch(base+file);if(!r.ok)throw Error('Missing fauna animation');
  const a=await new Response(r.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
  if(a.byteLength!==w*h*8)throw Error('Invalid fauna animation');
  const t=new THREE.DataTexture(new Uint16Array(a),w,h,THREE.RGBAFormat,THREE.HalfFloatType);
  t.needsUpdate=true;t.minFilter=t.magFilter=THREE.NearestFilter;t.generateMipmaps=false;return t;
}
function patch(mat,uniforms,normal=true){
  mat.onBeforeCompile=s=>{
    Object.assign(s.uniforms,uniforms);s.vertexShader=vertex+'\n'+s.vertexShader;
    s.vertexShader=s.vertexShader.replace('#include <begin_vertex>','vec3 transformed = faunaSample(uFaunaPosition);');
    if(normal)s.vertexShader=s.vertexShader.replace('#include <beginnormal_vertex>','vec3 objectNormal = normalize(faunaSample(uFaunaNormal));');
    if(normal)patchCloudShadow(s,cloudUniforms());   // same drifting cloud shade as the ground (Claude Code, render)
  };
  mat.customProgramCacheKey=()=>normal?'fauna-vat-normal-2':'fauna-vat-depth-1';
}
const fract=n=>n-Math.floor(n);
// static props (pen, posts, traps): cloud shade like everything else
const shaded=m=>{m.onBeforeCompile=s=>patchCloudShadow(s,cloudUniforms());m.customProgramCacheKey=()=>'fauna-prop-cloud-'+m.type;return m;};
function rand(seed){let s=seed>>>0;return()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
// (Claude Code, owner's request 2026-10-07) people are off for now until detailed models exist: the duck herder and the
// angler; an empty set brings them back
const PEOPLE_HIDDEN=new Set(['keeper','angler']);
const CAPS={duck:240,cattle:12,egret:56,'cattle-egret':12,sparrow:80,myna:24,dove:16,swallow:32,kingfisher:12,cormorant:10,'pond-heron':24,'grey-heron':10,keeper:4,angler:3,snakehead:12,perch:12,pomacea:24,pila:16,'snail-eggs':48};
const BIRDS=new Set(['egret','cattle-egret','sparrow','myna','dove','swallow','kingfisher','cormorant','pond-heron','grey-heron']);
const FISH=new Set(['snakehead','perch']);
const TINY=new Set(['pomacea','pila','snail-eggs']);
const RANGE={trap:65,splash:50,duck:260,cattle:600,egret:650,'cattle-egret':250,sparrow:110,myna:130,dove:130,swallow:180,kingfisher:100,cormorant:180,'pond-heron':220,'grey-heron':250,keeper:260,angler:100,snakehead:35,perch:15,pomacea:30,pila:30,'snail-eggs':60};
const COATS={duck:[0x9b8155,0x80613e,0xb29a70,0x715139,0xd3c8ad,0xe9e6da],cattle:[0xa45f26,0xba7b37,0x874124,0xb16b32,0x743522,0xc9c5b7]};
export class FaunaLayer {
  constructor(terrain,{mobile=false,streets=null,assetBase=ROOT,preview=false,renderer=null}={}){
    this.renderer=renderer;this.assetBase=assetBase;this.preview=preview;this.cacheToken=preview?Date.now():null;this.terrain=terrain;this.mobile=mobile;this.streets=streets;this.group=new THREE.Group();this.group.name='fauna';
    this.tiles=new Map();this.pending=new Map();this.retry=new Map();this.pools=[];this.lookup=new Map();this.time=0;this.dead=false;
    this.clock={value:0};this.frustum=new THREE.Frustum();this.matrix=new THREE.Matrix4();this.dummy=new THREE.Object3D();this.colour=new THREE.Color();
    this.effects=new FaunaEffects(mobile);this.group.add(this.effects.mesh);this.nextStream=0;this.nextWires=0;this.wireBirds=[];
    this.stats={triangles:0,calls:0,animals:0,cpuMs:0,vatBytes:0};
  }
  async loadIndex(){
    if(!this.index){const r=await fetch(DATA+'index.json');if(!r.ok)throw Error('Missing fauna index');this.index=await r.json();this.pilot=this.index.pilot;
      this.tileIndex=new Map(this.index.tiles.map(t=>[t.key,t]));}
    return this.index;
  }
  async load(){
    const url=file=>this.assetBase+file+(this.preview?'?review='+this.cacheToken:'');
    const [index,kit]=await Promise.all([this.preview?Promise.resolve(null):this.loadIndex(),fetch(url('kit.json')).then(r=>r.json())]);this.kit=kit;if(!this.preview)this.fieldClassifier=CPU_FIELDS;const loader=new GLTFLoader();
    if(kit.atlas){this.atlas=await new THREE.TextureLoader().loadAsync(url(kit.atlas.file));this.atlas.colorSpace=THREE.SRGBColorSpace;this.atlas.anisotropy=2;this.atlas.flipY=false;}
    // Sequential species, parallel mesh/VAT fetch within a species: bounded peak loading memory.
    for(const a of kit.assets){
      const [gltf,pos,norm]=await Promise.all([loader.loadAsync(url(a.file)),vat('',url(a.position),a.width,a.height),vat('',url(a.normal),a.width,a.height)]);
      let src;gltf.scene.traverse(o=>{if(o.isMesh)src=o;});const geometry=src.geometry,uv=geometry.getAttribute('uv1');
      if(!uv)throw Error('Fauna VAT vertex ids missing');geometry.setAttribute('aVat',new THREE.Float32BufferAttribute(Array.from({length:uv.count},(_,i)=>uv.getX(i)),1));
      const capacity=this.mobile?Math.max(1,Math.floor((CAPS[a.id]||8)/6)):(CAPS[a.id]||8);
      const clips=new THREE.InstancedBufferAttribute(new Float32Array(capacity*4),4);clips.setUsage(THREE.DynamicDrawUsage);geometry.setAttribute('aClip',clips);
      const uniforms={uFaunaPosition:{value:pos},uFaunaNormal:{value:norm},uFaunaSize:{value:new THREE.Vector2(a.width,a.height)},uFaunaTime:this.clock};
      const mat=new THREE.MeshStandardMaterial({map:this.atlas||null,vertexColors:true,roughness:.88,side:THREE.DoubleSide});patch(mat,uniforms);
      const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,side:THREE.DoubleSide});patch(depth,uniforms,false);mat.userData.depthMaterial=depth;
      const mesh=new THREE.InstancedMesh(geometry,mat,capacity);mesh.name='fauna-'+a.id+'-'+a.lod;mesh.count=0;mesh.frustumCulled=false;
      mesh.userData.noShadow=a.lod>0||FISH.has(a.id)||TINY.has(a.id);mesh.userData.noReflect=true;mesh.userData.fauna=true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);for(let i=0;i<capacity;i++)mesh.setColorAt(i,this.colour.set(0xffffff));
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);this.group.add(mesh);
      const pool={a,mesh,clips,capacity,pos,norm,depth,count:0};this.pools.push(pool);this.lookup.set(a.id+'-'+a.lod,pool);this.stats.vatBytes+=a.width*a.height*16;if(src.material.map)src.material.map.dispose();src.material.dispose();
      if(this.dead){this.dispose();return;}
    }
    const g=await loader.loadAsync(url('herder-pen.glb'));let src;g.scene.traverse(o=>{if(o.isMesh)src=o;});
    this.support=new THREE.InstancedMesh(src.geometry,shaded(src.material),4);this.support.name='fauna-pen';this.support.count=0;this.support.frustumCulled=false;this.support.userData.noShadow=true;this.support.userData.noReflect=true;this.support.userData.fauna=true;this.group.add(this.support);
    // Canal perches and tether stakes share a single tiny wood batch.
    this.posts=new THREE.InstancedMesh(new THREE.CylinderGeometry(.022,.03,1,5),shaded(new THREE.MeshStandardMaterial({color:0x655238,roughness:1})),40);
    this.posts.geometry.translate(0,.5,0);this.posts.frustumCulled=false;this.posts.count=0;this.posts.userData.fauna=true;this.posts.userData.noReflect=true;this.group.add(this.posts);
    this.ropeArray=new Float32Array(24*5*6);const rg=new THREE.BufferGeometry();rg.setAttribute('position',new THREE.BufferAttribute(this.ropeArray,3).setUsage(THREE.DynamicDrawUsage));
    this.ropes=new THREE.LineSegments(rg,new THREE.LineBasicMaterial({color:0x887049}));this.ropes.frustumCulled=false;this.ropes.userData.noShadow=true;this.ropes.userData.noReflect=true;this.group.add(this.ropes);
    this.traps=new THREE.InstancedMesh(new THREE.CylinderGeometry(.23,.16,.7,10,3,true),shaded(new THREE.MeshStandardMaterial({color:0x9f8755,wireframe:true})),6);
    this.traps.geometry.rotateZ(Math.PI/2);this.traps.frustumCulled=false;this.traps.userData.noShadow=true;this.traps.userData.fauna=true;this.traps.userData.noReflect=true;this.group.add(this.traps);
    if(this.dead){this.dispose();return;}this.ready=true;
    if(this.preview)return;
    const key=Math.floor(index.pilot.x/index.cell_m)+'_'+Math.floor(index.pilot.north/index.cell_m);await this.loadTile(this.tileIndex.get(key));
  }
  valid(x,n){const s=this.terrain.surface,w=this.terrain.wetland,stage=fieldStage(x,n);
    return stage>.94&&stage<.99&&(!s||(s.waterAt(x,n)<.1&&s.cropAt(x,n)>.8))&&(!w||w.floodAt(x,n)<.05);}
  validSeedling(x,n){const s=this.terrain.surface,w=this.terrain.wetland;return fieldStage(x,n)<.18&&(!s||s.cropAt(x,n)>.8&&s.waterAt(x,n)<.5)&&(!w||w.floodAt(x,n)<.05);}
  height(x,n){return this.terrain.heightAt(x,n)*this.terrain.ex;}
  waterHeight(x,n){return this.terrain.surface?.waterHeight(x,n)??this.height(x,n);}
  async loadTile(t){
    if(!t||this.tiles.has(t.file)||this.pending.has(t.file)||this.dead||(this.retry.get(t.file)||0)>this.time)return;
    const task=fetch(DATA+t.file).then(async r=>{if(!r.ok)throw Error('Missing fauna tile');return JSON.parse(await new Response(r.body.pipeThrough(new DecompressionStream('deflate'))).text());}).then(data=>{
      if(this.dead)return;const animals=[],supports=[],groups=[];
      const animal=(id,x,n,random,extra={})=>{const h=(extra.mode==='water'||extra.mode==='egg-post'||extra.mode==='snail'&&extra.site?.waterEdge)?this.waterHeight(x,n)+(extra.height||0):this.height(extra.groundX??x,extra.groundNorth??n)+(extra.height||0);
        return {id,x,n,h,baseX:x,baseN:n,phase:random(),yaw:random()*6.283,scale:.9+random()*.2,route:0,flight:null,cooldown:0,...extra};};
      for(const g of data.groups){
        if(!this.fieldClassifier&&!this.preview)continue;
        const random=rand(g.seed),patch=fieldPatch(g.x,g.north),cols=blockLayout(patch.id[0],patch.id[1]).cols;
        const dx=cols?-Math.sin(FIELD.angle):Math.cos(FIELD.angle),dn=cols?Math.cos(FIELD.angle):Math.sin(FIELD.angle);
        const group={...g,dx,dn,driftX:0,driftN:0};groups.push(group);
        let keeper=null;
        for(let j=0;j<12&&!keeper;j++){const a=Math.atan2(-dx,-dn)+(j%2?1:-1)*Math.floor(j/2)*Math.PI/6,x=g.x+Math.sin(a)*16,n=g.north+Math.cos(a)*16;
          if([[-4,-4],[-4,4],[4,-4],[4,4],[0,0]].every(([u,v])=>this.valid(x+u,n+v)))keeper={x,n,h:this.height(x,n)};}
        if(!keeper)continue;supports.push(keeper);
        for(const [id,num] of [['duck',g.ducks],['cattle',g.cattle],['egret',g.egrets]]){
          let spawned=0;
          for(let j=0;j<num*30&&spawned<num;j++){
            const lead=random()<.72,along=id==='duck'?(lead?3+random()*8:-13+random()*18):Math.sin(random()*6.283)*(11+random()*2);
            const across=id==='duck'?(random()-.5)*(lead?7:5):Math.cos(random()*6.283)*(11+random()*2);
            const x=g.x+dx*along-dn*across,n=g.north+dn*along+dx*across;
            if(!this.valid(x,n)||animals.some(a=>Math.hypot(a.x-x,a.n-n)<(id==='cattle'?1.7:.46)))continue;
            if(![[-2,-2],[-2,2],[2,-2],[2,2]].every(([u,v])=>this.valid(x+u,n+v)))continue;
            animals.push(animal(id,x,n,random,{group,route:id==='cattle'?.25:.13,coat:COATS[id]?.[Math.floor(random()*COATS[id].length)],tether:id==='cattle'&&spawned%2===0,mode:'field'}));spawned++;
          }
        }
        const cows=animals.filter(a=>a.group===group&&a.id==='cattle');
        for(const cow of cows){const x=cow.x+.8,n=cow.n+.5;if(this.valid(x,n))animals.push(animal('cattle-egret',x,n,random,{group,mode:'field',route:.10}));}
        // One occasional riding egret, attached to its cow until it flushes.
        if(cows.length&&(g.seed%2||g.x===this.pilot.x&&g.north===this.pilot.north))animals.push(animal('cattle-egret',cows[0].x,cows[0].n,random,{group,mode:'ride',cow:cows[0],height:this.lookup.get('cattle-0').a.ride_anchor_m?.[1]||1.084}));
        const kx=keeper.x-dn*4,kn=keeper.n+dx*4;
        animals.push(animal('keeper',this.valid(kx,kn)?kx:keeper.x,this.valid(kx,kn)?kn:keeper.n,random,{group,mode:'field',route:.5}));
      }
      for(const s of data.sites){if(!this.fieldClassifier&&(s.mode==='seedling'||s.mode==='snail'&&!s.waterEdge))continue;const random=rand(s.seed);
        for(let i=0;i<s.num;i++){
          let x=s.x,n=s.north;
          if(s.positions){[x,n]=s.positions[i];}
          else if(s.mode==='sky'){const t=i-(s.num-1)/2,L=t*3.3,F=-(s.formation==='v'?Math.abs(t)*2:t*.7),yaw=s.yaw||0;x+=Math.cos(yaw)*L+Math.sin(yaw)*F;n+=Math.sin(yaw)*L-Math.cos(yaw)*F;}
          else if(s.mode==='roof'){x+=Math.cos(s.yaw||0)*(i-(s.num-1)/2)*.22;n-=Math.sin(s.yaw||0)*(i-(s.num-1)/2)*.22;}
          else{x+=(random()-.5)*(s.radius||0);n+=(random()-.5)*(s.radius||0);}
          if(s.mode==='seedling'&&!this.validSeedling(x,n))continue;
          if(s.support==='post'&&TINY.has(s.id)){const radius=.03-.008*THREE.MathUtils.clamp((s.height||0)/(s.postHeight||.5),0,1),offset=radius-(s.id==='snail-eggs'?.0012:.004);x+=Math.sin(s.yaw||0)*offset;n-=Math.cos(s.yaw||0)*offset;}
          animals.push(animal(s.id,x,n,random,{mode:s.mode,groundX:s.mode==='sky'?s.x:s.groundX,groundNorth:s.mode==='sky'?s.north:s.groundNorth,route:s.mode==='yard'?s.radius*.12:s.mode==='bank'&&s.id!=='angler'?.04:s.mode==='seedling'?.035:s.mode==='snail'?.02:0,height:s.height||0,yaw:s.yaw??(TINY.has(s.id)&&s.support==='post'?0:random()*6.283),site:s,flock:s,flockIndex:i}));
        }
      }
      let filtered=animals;
      if(this.fieldClassifier){
        const field=animals.filter(a=>a.mode==='seedling'||a.mode==='field'||a.mode==='snail'&&!a.site?.waterEdge),points=field.flatMap(a=>[a.x,a.n]);
        if(field.length){const stage=this.fieldClassifier.classify(points),invalid=new Set();for(let i=0;i<field.length;i++){const a=field[i],k=stage[i]/255;if(a.mode==='field'?k<=.92+FIELD_MARGIN:k>=.18-FIELD_MARGIN)invalid.add(a);}filtered=animals.filter(a=>!invalid.has(a));this.stats.fieldRejected=(this.stats.fieldRejected||0)+invalid.size;}
      }
      this.tiles.set(t.file,{t,animals:filtered.filter(a=>!PEOPLE_HIDDEN.has(a.id)),supports,groups,sphere:new THREE.Sphere(new THREE.Vector3(t.x,this.height(t.x,t.north),-t.north),data.sites.some(s=>s.mode==='sky')?Math.max(t.radius,990):t.radius)});
    }).catch(e=>{this.retry.set(t.file,this.time+30);console.warn('Fauna:',e.message);}).finally(()=>this.pending.delete(t.file));this.pending.set(t.file,task);return task;
  }
  stream(camera){
    if(this.preview||this.time<this.nextStream)return;this.nextStream=this.time+.6;const C=this.index.cell_m,x=Math.floor(camera.position.x/C),n=Math.floor(-camera.position.z/C);
    for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++){const t=this.tileIndex.get((x+i)+'_'+(n+j));if(t)this.loadTile(t);}
    for(const [key,tile] of this.tiles)if(Math.hypot(tile.t.x-camera.position.x,tile.t.north+camera.position.z)>2400)this.tiles.delete(key);
  }
  cableBirds(camera){
    if(!this.streets||this.time<this.nextWires)return;this.nextWires=this.time+2;
    const old=new Map(this.wireBirds.map(a=>[a.key,a])),next=[];
    this.streets.group.traverse(o=>{
      if(!o.userData.faunaCable||next.length>30)return;const p=o.geometry.getAttribute('position');
      for(let i=0;i<p.count-1;i+=18){const x=p.getX(i),h=p.getY(i)+.012,n=-p.getZ(i);
        if(Math.hypot(x-camera.position.x,h-camera.position.y,n+camera.position.z)>170)continue;
        if(this.terrain.wetland?.floodAt(x,n)>.05)continue;
        const random=rand(Math.round(x*30+n*17));if(random()>.10)continue;
        const rowKey=o.uuid+':'+i,flock=old.get(rowKey+':0')?.flock||{};
        for(let j=0;j<3&&next.length<30;j++){
          const t=.35+j*.15,px=x+(p.getX(i+1)-x)*t,ph=h+(p.getY(i+1)+.012-h)*t,pn=n+(-p.getZ(i+1)-n)*t,key=rowKey+':'+j;
          const a=old.get(key)||{id:'swallow',x:px,n:pn,h:ph,baseX:px,baseN:pn,phase:random(),yaw:random()*6.283,scale:1,route:0,flight:null,cooldown:0,mode:'wire',key,flock};next.push(a);
        }
      }
    });this.wireBirds=next;
  }
  matrixAt(mesh,i,x,y,n,yaw=0,scale=1,pitch=0){this.dummy.position.set(x,y,-n);this.dummy.rotation.set(pitch,yaw,0);if(mesh===this.posts)this.dummy.scale.set(1,scale,1);else this.dummy.scale.setScalar(scale);this.dummy.updateMatrix();mesh.setMatrixAt(i,this.dummy.matrix);}
  update(camera,dt){
    const start=performance.now();if(!this.ready||!this.group.visible){Object.assign(this.stats,{cpuMs:0,triangles:0,calls:0,animals:0});return;}
    this.time+=Math.min(dt,.1);this.clock.value=this.time;this.stream(camera);this.cableBirds(camera);
    this.matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);this.frustum.setFromProjectionMatrix(this.matrix);
    for(const p of this.pools)p.count=0;this.support.count=0;this.posts.count=0;this.traps.count=0;this.effects.reset();this.ropeCount=0;const tinyPosts=new Set();
    let tri=0,calls=0,animals=0;const used={};
    const cattleAnchor=(a,kind,clip)=>{
      const asset=this.lookup.get('cattle-0').a,c=asset.clips.find(c=>c.name===clip)||asset.clips[0],table=asset[kind+'_anchors_m'];
      if(!table)return kind==='ride'?[0,1.084,0]:[0,.64,1.0];
      const f=fract(this.time/c.duration+a.phase)*asset.frames,k=Math.floor(f),p=table[c.start+k],q=table[c.start+(k+1)%asset.frames];
      return p.map((v,i)=>THREE.MathUtils.lerp(v,q[i],fract(f)));
    };
    const emit=(a,y,clip)=>{
      const d=Math.hypot(a.x-camera.position.x,y-camera.position.y,a.n+camera.position.z);
      if(d>Math.min(RANGE[a.id]||0,this.mobile?150:650))return;
      const lod=d>80?1:0,p=this.lookup.get(a.id+'-'+lod);if(!p||used[a.id]>=p.capacity||tri+p.a.triangles>146000||(!p.count&&calls>=15))return;
      if(!p.count)calls++;used[a.id]=(used[a.id]||0)+1;tri+=p.a.triangles;animals++;
      const c=p.a.clips.find(c=>c.name===clip)||p.a.clips[0],i=p.count++;
      this.matrixAt(p.mesh,i,a.x,y,a.n,a.yaw,a.scale,a.id!=='snail-eggs'&&TINY.has(a.id)&&a.site?.support==='post'?Math.PI/2:0);p.mesh.setColorAt(i,this.colour.set(a.coat??0xffffff));
      const once=clip==='take-off'||clip==='land',phase=once?-(a.flight.t+(clip==='land'?5.88:0))/c.duration:a.phase;
      p.clips.setXYZW(i,c.start,once?0:1,c.duration,phase);
    };
    const process=a=>{
      const d=Math.hypot(a.x-camera.position.x,a.h-camera.position.y,a.n+camera.position.z);
      if(d>Math.min((RANGE[a.id]||0)+35,this.mobile?180:685))return;
      let y=a.h,clip=a.id==='duck'?'dabble':a.id==='cattle'?'graze':'stand';
      if(a.mode==='sky'){
        const s=a.site,r=s.radius||170,t=this.time*(s.speed||7)/r+(s.seed%1000)*.001,yaw=s.yaw||0;
        const along=Math.sin(t)*r,across=Math.cos(t)*r*.08,heading=yaw+Math.atan2(-Math.sin(t)*.08,Math.cos(t));
        const q=a.flockIndex-(s.num-1)/2,L=q*3.3,F=-(s.formation==='v'?Math.abs(q)*2:q*.7);
        a.x=s.x+Math.sin(yaw)*along+Math.cos(yaw)*across+Math.cos(heading)*L+Math.sin(heading)*F;
        a.n=s.north-Math.cos(yaw)*along+Math.sin(yaw)*across+Math.sin(heading)*L-Math.cos(heading)*F;
        y=a.h+Math.sin(t*.3)*2;a.yaw=heading;emit(a,y,fract(t*3)<.72?'flap':'glide');return;
      }
      if(TINY.has(a.id)){
        if(d>(a.id==='snail-eggs'?60:30))return;const crawl=a.id!=='snail-eggs'&&d>1.2,t=this.time/90+a.phase,onPost=a.site?.support==='post';
        a.x=a.baseX+(crawl&&!onPost?Math.sin(t)*.015:0);a.n=a.baseN+(crawl&&!onPost?Math.cos(t)*.015:0);
        if(crawl&&onPost)y+=Math.sin(t)*.015;emit(a,y,a.id==='snail-eggs'?'stand':crawl?'crawl':'withdrawn');
        const postKey=onPost?a.site.x+':'+a.site.north:'';
        if(onPost&&!tinyPosts.has(postKey)&&this.posts.count<40){tinyPosts.add(postKey);const ph=a.site.postHeight||.5;this.matrixAt(this.posts,this.posts.count++,a.site.x,this.waterHeight(a.site.x,a.site.north),a.site.north,0,ph);}return;
      }
      if(a.id==='splash'||FISH.has(a.id)){
        const period=a.id==='splash'?37:a.id==='perch'?19:29,event=((this.time+a.phase*period)%period);
        const active=a.id==='perch'?.7:2.8;if(event>active||d>(a.id==='perch'?15:50))return;
        this.effects.emit(a.x,a.h,a.n,event/active,a.id==='splash'?1:0);
        if(FISH.has(a.id)&&event<active*.65){y=a.h+.01;clip=a.id==='snakehead'?'gulp':'flick';emit(a,y,clip);}return;
      }
      if(a.id==='trap'){if(d<65&&this.traps.count<6){this.matrixAt(this.traps,this.traps.count++,a.x,a.h+.07,a.n,a.yaw);}return;}
      if(BIRDS.has(a.id)&&a.mode!=='sky'&&!a.flight&&(d<(a.id==='sparrow'?10:19)||a.flock?.flush)&&this.time>a.cooldown){
        if(a.mode==='field'||a.mode==='ride'){
          const vx=a.x-camera.position.x,vn=a.n+camera.position.z,L=Math.hypot(vx,vn)||1;
          for(const turn of [0,.7,-.7,1.6,-1.6,Math.PI]){const dx=(vx*Math.cos(turn)-vn*Math.sin(turn))/L,dn=(vx*Math.sin(turn)+vn*Math.cos(turn))/L,tx=a.x+dx*25,tn=a.n+dn*25;
            if(Math.hypot(tx-a.group.x,tn-a.group.north)<24&&this.valid(tx,tn)){a.flight={t:this.time,x:a.x,n:a.n,h:a.h,tx,tn,th:this.height(tx,tn)};a.mode='field';a.cow=null;break;}}
        }else{
          // Nearby flock shares the same take-off epoch; a short airborne loop returns to its safe perch/yard.
          if(a.flock&&!a.flock.flush)a.flock.flush=this.time;
          a.flight={t:a.flock?.flush??this.time,x:a.baseX,n:a.baseN,h:a.h,tx:a.baseX,tn:a.baseN,th:a.h,loop:true};
        }
        a.cooldown=this.time+18;
      }
      if(a.flight){
        const f=a.flight,k=Math.min(1,(this.time-f.t)/7),e=k*k*(3-2*k);
        a.x=THREE.MathUtils.lerp(f.x,f.tx,e);a.n=THREE.MathUtils.lerp(f.n,f.tn,e);y=THREE.MathUtils.lerp(f.h,f.th,e)+Math.sin(k*Math.PI)*3.5;
        if(f.loop){a.x+=Math.sin(k*6.283)*2;a.n+=Math.sin(k*Math.PI)*2;a.yaw=k*6.283;}
        else a.yaw=Math.atan2(f.tx-f.x,-(f.tn-f.n));
        clip=a.id==='egret'?(k<.12?'take-off':k>.84?'land':k>.4&&k<.75?'glide':'flap'):(k>.4&&k<.75?'glide':'flap');
        if(k===1){a.baseX=a.x;a.baseN=a.n;a.h=f.th;a.flight=null;if(a.flock)a.flock.flush=null;clip='stand';}
      }else if(a.mode==='skim'){
        const t=this.time*.7+a.phase*6.283;a.x=a.baseX+Math.sin(t)*7;a.n=a.baseN+Math.cos(t)*3;
        y=this.height(a.x,a.n)+1.7+Math.sin(t*2)*.25;a.yaw=Math.atan2(Math.cos(t)*7,Math.sin(t)*3);clip=fract(t/6.283)<.65?'flap':'glide';
      }else if(a.cow){
        const cow=a.cow,cycle=fract(this.time/14+cow.phase),clip=cycle<.3&&cow.route>0?'walk':cycle>.86?'tail-flick':'graze',anchor=cattleAnchor(cow,'ride',clip);
        a.x=cow.x;a.n=cow.n;y=cow.h+anchor[1]*cow.scale;a.h=y;
      }
      else{
        const cycle=fract(this.time/14+a.phase),walk=cycle<.3&&a.route>0,ang=cycle/.3*Math.PI*2;
        let dx=walk?Math.sin(ang)*a.route:0,dn=walk?Math.cos(ang)*a.route:0;
        if(a.group&&(a.id==='duck'||a.id==='keeper')){const drift=Math.sin(this.time*Math.PI/180)*1.5;dx+=a.group.dx*drift;dn+=a.group.dn*drift;}
        const x=a.baseX+dx,n=a.baseN+dn;
        if(a.mode==='seedling'?this.validSeedling(x,n):a.mode!=='field'||this.valid(x,n)){a.x=x;a.n=n;}
        if(walk){a.yaw=Math.atan2(Math.cos(ang),Math.sin(ang));clip=a.id==='duck'?'waddle':'walk';}
        else clip=['egret','pond-heron','grey-heron','cattle-egret'].includes(a.id)?(cycle<.65?(a.id==='egret'?'stab-feed':'feed'):'stand'):a.id==='cattle'?(cycle>.86?'tail-flick':'graze'):a.id==='duck'?'dabble':a.id==='cormorant'?'wing-dry':a.mode==='yard'?'feed':'stand';
        if(a.id==='keeper'){clip='walk';a.yaw=Math.atan2(a.group.dx,-a.group.dn);}
        if(a.route||a.group){y=this.height(a.x,a.n)+(a.height||0);a.h=y;}
      }
      emit(a,y,clip);
      if(a.mode==='post'&&d<80&&this.posts.count<40){this.matrixAt(this.posts,this.posts.count++,a.baseX,a.h-a.height,a.baseN,0,a.height);}
      if(a.id==='angler'&&a.site?.waterX!==undefined&&d<100&&this.ropeCount<24){const tip=[...(this.kit.angler_rod_tip||[.42,1.31,2.65])],c=this.lookup.get('angler-0').a.clips[0],frame=fract(this.time/c.duration+a.phase)*16,k=Math.floor(frame),wave=THREE.MathUtils.lerp(Math.sin(k*Math.PI/8),Math.sin(((k+1)%16)*Math.PI/8),fract(frame));tip[1]+=.004*wave;tip[2]+=.045*wave;const sx=a.x+(Math.cos(a.yaw)*tip[0]+Math.sin(a.yaw)*tip[2])*a.scale,sn=a.n+(Math.sin(a.yaw)*tip[0]-Math.cos(a.yaw)*tip[2])*a.scale,sh=y+tip[1]*a.scale,tx=a.site.waterX,tn=a.site.waterNorth,th=this.waterHeight(tx,tn)+.02;
        for(let j=0;j<5;j++)for(const [t,k] of [[j/5,0],[(j+1)/5,3]]){const o=(this.ropeCount*5+j)*6;this.ropeArray[o+k]=THREE.MathUtils.lerp(sx,tx,t);this.ropeArray[o+k+1]=THREE.MathUtils.lerp(sh,th,t)-.04*Math.sin(t*Math.PI);this.ropeArray[o+k+2]=-THREE.MathUtils.lerp(sn,tn,t);}this.ropeCount++;}
      if(a.tether&&d<80&&this.ropeCount<12){
        const sx=a.baseX-1.1,sn=a.baseN-.5,sh=this.height(sx,sn);
        if(this.posts.count<40)this.matrixAt(this.posts,this.posts.count++,sx,sh,sn,0,.6);
        const anchor=cattleAnchor(a,'tether',clip),mx=a.x+(Math.cos(a.yaw)*anchor[0]+Math.sin(a.yaw)*anchor[2])*a.scale,mn=a.n+(Math.sin(a.yaw)*anchor[0]-Math.cos(a.yaw)*anchor[2])*a.scale,mh=y+anchor[1]*a.scale;
        for(let j=0;j<5;j++){const q=j/5,r=(j+1)/5,o=(this.ropeCount*5+j)*6;
          for(const [t,k] of [[q,0],[r,3]]){this.ropeArray[o+k]=THREE.MathUtils.lerp(sx,mx,t);this.ropeArray[o+k+1]=THREE.MathUtils.lerp(sh+.45,mh,t)-.18*Math.sin(t*Math.PI);this.ropeArray[o+k+2]=-THREE.MathUtils.lerp(sn,mn,t);}}
        this.ropeCount++;
      }
    };
    // Rank nearby individuals too: a distant group in the same cell cannot take foreground caps.
    const candidates=[];
    for(const tile of this.tiles.values()){
      if(!this.frustum.intersectsSphere(tile.sphere))continue;
      for(const a of tile.animals){const limit=Math.min((RANGE[a.id]||0)+35,this.mobile?180:685),d=(a.x-camera.position.x)**2+(a.h-camera.position.y)**2+(a.n+camera.position.z)**2;if(d<=limit*limit){a.cameraDistanceSq=d;candidates.push(a);}}
      for(const s of tile.supports)if(this.support.count<4&&Math.hypot(s.x-camera.position.x,s.h-camera.position.y,s.n+camera.position.z)<260)this.matrixAt(this.support,this.support.count++,s.x,s.h,s.n);
    }
    for(const a of this.wireBirds){a.cameraDistanceSq=(a.x-camera.position.x)**2+(a.h-camera.position.y)**2+(a.n+camera.position.z)**2;candidates.push(a);}
    candidates.sort((a,b)=>a.cameraDistanceSq-b.cameraDistanceSq);for(const a of candidates)process(a);
    this.effects.finish();tri+=this.effects.count*8;calls+=this.effects.count?1:0;
    for(const p of this.pools){p.mesh.count=p.count;p.mesh.visible=p.count>0;if(p.count){p.mesh.instanceMatrix.needsUpdate=true;p.mesh.instanceColor.needsUpdate=true;p.clips.needsUpdate=true;}}
    for(const [mesh,cost] of [[this.support,this.kit.support_triangles],[this.posts,20],[this.traps,60]]){mesh.visible=mesh.count>0;if(mesh.count){mesh.instanceMatrix.needsUpdate=true;calls++;tri+=mesh.count*cost;}}
    this.ropes.visible=this.ropeCount>0;this.ropes.geometry.setDrawRange(0,this.ropeCount*10);if(this.ropeCount){this.ropes.geometry.attributes.position.needsUpdate=true;calls++;}
    Object.assign(this.stats,{triangles:tri,calls,animals,cpuMs:performance.now()-start,loadedTiles:this.tiles.size,pendingTiles:this.pending.size});
  }
  dispose(){
    this.dead=true;this.ready=false;this.tiles.clear();
    for(const p of this.pools){p.mesh.geometry.dispose();p.mesh.material.dispose();p.pos.dispose();p.norm.dispose();p.depth.dispose();p.mesh.dispose();}this.pools=[];this.lookup.clear();
    for(const mesh of [this.support,this.posts,this.traps,this.ropes])if(mesh){mesh.geometry.dispose();mesh.material.dispose();mesh.dispose?.();}
    this.fieldClassifier?.dispose();this.atlas?.dispose();this.effects.dispose();this.group.clear();this.group.removeFromParent();
  }
}
